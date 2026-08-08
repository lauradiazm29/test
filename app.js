/* ==========================================================================
   Crime indicators, Community of Madrid
   ---------------------------------------------------------------------------
   One file, no build step, no framework. The page is a static site: the
   PostgreSQL database has already been queried by notebooks/04_indicators.ipynb
   and every number this page can display is sitting in data/*.json.

   Only two things are computed in the browser, and both because both depend on
   a choice the visitor makes: the class breaks of the map, and the weighted
   index of module A.

   Structure of the file:

     1.  Configuration, module descriptions, helpers
     2.  Data loading and normalisation
     3.  Map: boundaries only, quantile classes, legend
     4.  Chart helpers
     5.  Table: rendering, sorting, CSV export
     6.  Modules A to D
     7.  Methodology tab
     8.  Controls and start up

   The whole interface is driven by one object, `state`. Every control writes
   into it and every drawing function reads from it, so adding a control means
   adding one element to index.html and one line to the module's draw function.
   ========================================================================== */

'use strict';

/* ==========================================================================
   1. Configuration and helpers
   ========================================================================== */

const CLASSES = 5;
const PALETTE = ['#eef3f8', '#c3d4e6', '#8fb0d3', '#5a86ba', '#2c5c96'];
const NO_DATA = '#d9d9d9';
const ACCENT  = '#b03a2e';
const PINK    = '#c2708a';
const GREY    = '#9aa5b1';

/* The aggregate over the eleven offence concepts that are comparable across
   every year. The database calls it TOTAL in the original indicators script and
   ALL_COMPARABLE in the corrected one; the page normalises both to this. */
const AGG = 'ALL_COMPARABLE';

const AGE_ORDER = ['0-13', '14-17', '18-30', '31-40', '41-64', '65+', 'U'];
const AGE_LABEL = { 'U': 'unknown age' };
const SEX_LABEL = { 'M': 'Male', 'F': 'Female', 'U': 'Unknown' };
const COMPARABLE_BANDS = ['14-17', '18-30', '31-40', '41-64', '65+'];

/* Weight presets for module A. The severity scale is ordinal, from 1 for the
   least serious concept to 5 for completed homicide. It is a defensible first
   draft and nothing more: deriving weights from the sentence ranges of the
   Spanish Penal Code would be a stronger justification, and is the reason the
   weights are editable on the page rather than fixed here. */
const PRESETS = {
  uniform:  () => 1,
  severity: (t) => ({
    HOM_COMPLETED: 5, HOM_ATTEMPTED: 4, KIDNAPPING: 4, SEXUAL: 4,
    INJURY: 3, ROBBERY_VIOLENT: 3, BURGLARY: 2, VEHICLE_THEFT: 2,
    DRUG_TRAFFICKING: 2, THEFT: 1, OTHER: 1
  })[t.code] ?? 1,
  violent:  (t) => (t.violence === 'violent' ? 1 : 0)
};

/* The three indicators of module A, and which exported column each one is.
   The scaled columns exist only for the population denominator: per square
   kilometre the quantity anyone wants is the rate itself, and multiplying it
   by a thousand would give offences per thousand square kilometres. */
const A_INDICATORS = {
  per1000: { field: 'rate_per_1000', denominator: 'population',
             unit: 'offences per 1,000 inhabitants', scale: 1000,
             weightedUnit: 'weighted points per 1,000 inhabitants' },
  perkm2:  { field: 'rate', denominator: 'area',
             unit: 'offences per km²', scale: 1,
             weightedUnit: 'weighted points per km²' },
  count:   { field: 'offences', denominator: 'population',
             unit: 'recorded offences', scale: null,
             weightedUnit: 'weighted points' }
};

const B_INDICATORS = {
  clearance_rate: { label: 'Clearance rate', unit: 'clearance rate, %', percent: true },
  unsolved:       { label: 'Unsolved offences', unit: 'unsolved offences', percent: false },
  recorded:       { label: 'Recorded offences', unit: 'recorded offences', percent: false },
  cleared:        { label: 'Cleared offences', unit: 'cleared offences', percent: false }
};

const D_INDICATORS = {
  violent_share: {
    label: 'Violent share', unit: 'share of classified offences',
    plain: 'Of the offences that can be classified as violent or not, this is the fraction that are violent.'
  },
  violent_ratio: {
    label: 'Violent to non violent ratio', unit: 'violent per non violent offence',
    plain: 'How many violent offences there are for each non violent one.'
  },
  shannon_normalised: {
    label: 'Variety of offences, normalised', unit: '0 to 1',
    plain: 'Close to 0 means one or two offence types dominate; close to 1 means offences are spread evenly across the types present.'
  },
  shannon: {
    label: 'Variety of offences, Shannon entropy', unit: 'nats',
    plain: 'The raw entropy of the offence mix, before dividing by the maximum it could reach.'
  },
  unclassified_share: {
    label: 'Share that cannot be classified', unit: 'share of all offences',
    plain: 'The fraction of offences that fall in the residual category, which mixes violent and non violent conduct and is left out of the violent share.'
  }
};

const state = {
  module: 'A',
  year: null,
  selected: null,
  a: { indicator: 'per1000', crime: AGG, weighted: false, weights: {} },
  b: { indicator: 'clearance_rate', crime: 'TOTAL', level: 1 },
  c: { indicator: 'cases', measure: 'victims', crime: 'TOTAL' },
  d: { indicator: 'violent_share' }
};

const data = {};
let meta = null;
let boundaries = null;
let NAMES = {};
let AREA = {};                 // ine_code -> surface km2
let POP = {};                  // "ine|year" -> resident population
const charts = {};
let table = null;

const $ = (id) => document.getElementById(id);

function fmt(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  if (digits === undefined) digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 3;
  return Number(value).toLocaleString('en-GB', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  });
}

function titleCase(text) {
  const small = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'a']);
  return text.toLowerCase().split(' ')
    .map((w, i) => (i > 0 && small.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function banner(message, isError) {
  let element = $('banner');
  if (!element) {
    element = document.createElement('div');
    element.id = 'banner';
    document.body.insertBefore(element, $('module-intro'));
  }
  element.textContent = message;
  element.className = isError ? 'error' : '';
  element.hidden = false;
}

function hideBanner() { const b = $('banner'); if (b) b.hidden = true; }

const isWeighted = () => state.a.weighted;


/* --------------------------------------------------------------------------
   Module descriptions.

   Written for a reader who has never seen a crime statistic. Every module says
   what it measures, what a high value means, and what it does not mean, which
   is the part usually left out. The formula sits behind a disclosure widget so
   that it is available without being the first thing anybody sees.
   -------------------------------------------------------------------------- */

const MODULE_INFO = {
  A: {
    title: 'Module A. Crime level: how much crime there is, relative to size',
    lead: 'How many offences the police recorded in each municipality, divided by something that makes municipalities comparable. Twenty thousand offences in Madrid and two hundred in a village are not comparable numbers until they are put next to how many people live there, or how large the place is.',
    points: [
      '<strong>Per 1,000 inhabitants</strong> answers "how likely is an offence to be recorded where I live". This is the usual reading.',
      '<strong>Per square kilometre</strong> answers "how concentrated is crime in space". Dense city municipalities score high even when their per person rate is ordinary.',
      '<strong>Number of offences</strong> is the raw count, useful for knowing how much police work a place generates and useless for comparing places of different sizes.',
      'The <strong>weighted index</strong> button lets you decide how much each kind of offence counts.',
      'A high value does not mean a place is dangerous for you. It counts offences recorded against everyone present, including commuters and visitors, but divides by residents only.'
    ],
    formula: `
      <div class="formula">CL(i,t) = C(i,t) / D(i,t) &times; k
        <span class="where">C(i,t) = offences recorded in municipality i in year t<br>
        D(i,t) = resident population, or surface area in km&sup2;<br>
        k = 1,000 for the population denominator, 1 for the area denominator</span>
      </div>
      <p>The weighted version replaces the count by a weighted sum over offence
      types, so that a homicide need not count the same as a bicycle theft:</p>
      <div class="formula">CL<sub>w</sub>(i,t) = ( &Sigma;<sub>c</sub> w<sub>c</sub> &middot; C(c,i,t) ) / D(i,t) &times; k
        <span class="where">w<sub>c</sub> = the weight you give to offence type c<br>
        With every w<sub>c</sub> = 1 this is exactly the unweighted indicator above.</span>
      </div>`
  },

  B: {
    title: 'Module B. Police performance: how many offences are cleared',
    lead: 'For every offence category, how many offences were recorded in the Community of Madrid and how many of them the police cleared, meaning that a suspect was identified or the case was otherwise resolved. The ratio between the two is the clearance rate.',
    points: [
      '<strong>Clearance rate</strong> is the share of recorded offences that were cleared. Higher is better, but it is easier to clear some kinds of offence than others, so categories are not comparable with each other in any simple way.',
      '<strong>Unsolved offences</strong> is what is left over. Its composition tells you which categories account for most of the unresolved case load.',
      'These figures exist for the region as a whole. The source publishes no breakdown by municipality, which is why this module has no map.',
      'A rate above 100 per cent is possible and is not an error: an offence recorded in one year can be cleared in the next, so the two counts cover the same period but not the same offences.'
    ],
    formula: `
      <div class="formula">CR(c,t) = S(c,t) / R(c,t)
        <span class="where">R(c,t) = offences of category c recorded in year t<br>
        S(c,t) = offences of category c cleared in year t</span>
      </div>
      <div class="formula">UCP(c,t) = max( R(c,t) &minus; S(c,t), 0 )
        <span class="where">unsolved offences, floored at zero</span>
      </div>
      <div class="formula">USL(c,t) = U(c,t) / &Sigma;<sub>c'</sub> U(c',t)
        <span class="where">share of the unsolved offences of that year accounted for by
        category c, computed among the categories of the same level of the
        classification so that the shares add to 100 per cent and a parent
        category is never counted together with its own subcategories</span>
      </div>`
  },

  C: {
    title: 'Module C. Victims and offenders: who is involved',
    lead: 'The age and sex of the people recorded as victims of an offence, and of the people arrested or placed under investigation for one. The lower chart puts the two side by side, which is where the difference between them becomes visible.',
    points: [
      '<strong>Number of people</strong> is the raw count. <strong>Percentage of the total</strong> makes years and categories of very different size comparable.',
      'Victims are counted from age zero. Arrested and investigated persons are counted from age fourteen, the age of criminal liability in Spain, so only the bands from 14 to 17 upwards can be compared between the two.',
      'A person can appear more than once in a year, and a single offence can have several victims, so these are counts of records and not counts of distinct people.',
      'Records with unknown sex exist for victims. They are reported under the chart rather than folded into another category.'
    ],
    formula: `
      <div class="formula">S = cases / total
        <span class="where">share of the year and category total, taken over age bands and
        sexes together</span>
      </div>
      <div class="formula">VR = cases / population &times; 10,000
        <span class="where">people per ten thousand inhabitants of the same sex. The
        population available here is broken down by sex and not by age band, so
        this rate is meaningful only for the total over age bands and the page
        shows it only there.</span>
      </div>`
  },

  D: {
    title: 'Module D. Crime structure: what kind of crime it is',
    lead: 'Not how much crime a municipality has, but what it is made of. Two municipalities with the same rate can have completely different mixes: one dominated by theft, the other spread evenly across many offence types. These indicators have no denominator and no units, so a small municipality can score anywhere on them.',
    points: [
      '<strong>Violent share</strong> is the proportion of offences that are violent, among those that can be classified as violent or not.',
      '<strong>Variety of offences</strong> is the Shannon entropy of the mix. Low means one or two offence types dominate; high means the offences are spread evenly across many types. The normalised version runs from 0 to 1 and can be compared between municipalities.',
      '<strong>Share that cannot be classified</strong> is the important caveat: between 37 and 79 per cent of recorded offences fall in a residual category that mixes violent and non violent conduct. The violent share is computed over the rest, so read the two together.',
      'The chart beside the map shows the mix itself, which is the thing all of these numbers summarise.',
      'These indicators describe composition, not risk. A municipality with a high violent share can still have very few offences in absolute terms.'
    ],
    formula: `
      <div class="formula">VR = V / N &nbsp;&nbsp;&nbsp; VS = V / (V + N) &nbsp;&nbsp;&nbsp; US = U / total
        <span class="where">V = violent offences, N = non violent offences,
        U = offences that cannot be classified</span>
      </div>
      <div class="formula">SE = &minus; &Sigma;<sub>c</sub> p<sub>c</sub> ln p<sub>c</sub> &nbsp;&nbsp;&nbsp; NSE = SE / ln(crime_types_count)
        <span class="where">p<sub>c</sub> = share of offence type c in the municipality and year<br>
        crime_types_count = number of offence types actually present, which is
        the maximum the entropy could reach</span>
      </div>`
  },

  M: {
    title: 'Methodology, coverage and sources',
    lead: 'How the indicators are built, which municipalities the source covers, how to read the map, and what each number does not say.',
    points: [],
    formula: ''
  }
};

/** Plain language description of the indicator currently on screen. */
function currentIndicatorNote() {
  if (state.module === 'A') {
    const spec = A_INDICATORS[state.a.indicator];
    const what = isWeighted()
      ? 'your weighted index of all offence types'
      : (state.a.crime === AGG ? 'all offence types added together'
                               : (meta.crimeMun[state.a.crime] || state.a.crime).toLowerCase());
    if (state.a.indicator === 'count') {
      return `You are looking at the <strong>number of recorded offences</strong> for ${what}. ` +
             'This is a raw count: bigger municipalities have bigger numbers almost by definition.';
    }
    if (state.a.indicator === 'perkm2') {
      return `You are looking at <strong>${spec.unit}</strong> for ${what}. ` +
             'This measures how concentrated crime is in space, so dense urban municipalities score high.';
    }
    return `You are looking at <strong>${spec.unit}</strong> for ${what}. ` +
           'Roughly: for every thousand people living there, this many offences were recorded in the year.';
  }
  if (state.module === 'B') {
    const name = meta.crimeReg[state.b.crime] ? meta.crimeReg[state.b.crime].name_en : state.b.crime;
    return `You are looking at <strong>${B_INDICATORS[state.b.indicator].label.toLowerCase()}</strong> ` +
           `for ${name.toLowerCase()}, across the whole Community of Madrid.`;
  }
  if (state.module === 'C') {
    const name = meta.crimeReg[state.c.crime] ? meta.crimeReg[state.c.crime].name_en : state.c.crime;
    const who = state.c.measure === 'victims' ? 'victims' : 'arrested or investigated persons';
    return `You are looking at the age and sex of <strong>${who}</strong> for ` +
           `${name.toLowerCase()}, for the whole Community of Madrid.`;
  }
  if (state.module === 'D') {
    return `You are looking at <strong>${D_INDICATORS[state.d.indicator].label.toLowerCase()}</strong>. ` +
           D_INDICATORS[state.d.indicator].plain;
  }
  return '';
}


/* ==========================================================================
   2. Data loading and normalisation
   ========================================================================== */

async function loadTable(name) {
  const response = await fetch(`data/${name}.json`);
  if (!response.ok) throw new Error(`data/${name}.json could not be read (${response.status})`);
  const payload = await response.json();
  const columns = payload.columns;
  return payload.rows.map(row => {
    const object = {};
    for (let i = 0; i < columns.length; i++) object[columns[i]] = row[i];
    return object;
  });
}

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} (${response.status})`);
  return response.json();
}

/**
 * Make the page independent of which version of indicators.sql produced the
 * export. The original script calls the offence count `numerator` and the
 * synthetic aggregate `TOTAL`; the corrected one calls them `offences` and
 * `ALL_COMPARABLE`. Everything downstream then works from one vocabulary.
 */
function normalise() {
  data.crime_level.forEach(r => {
    if (r.offences === undefined) r.offences = r.numerator;
    if (r.crime_code === 'TOTAL') r.crime_code = AGG;
    // The uncorrected export scales the area denominator by a thousand as well,
    // where it would read as a rate per thousand inhabitants. Never used here.
    if (r.denominator === 'area') { r.rate_per_1000 = null; r.rate_per_100000 = null; }
  });
  data.demographic_profile.forEach(r => {
    if (r.is_age_total === undefined) r.is_age_total = (r.age === 'ALL');
    // The uncorrected export fills this in for every age band, where it is not
    // a rate at all because the denominator covers every age.
    if (!r.is_age_total) r.rate_per_10000 = null;
  });
}

function denomOf(ineCode, year, kind) {
  return kind === 'area' ? AREA[ineCode] : POP[`${ineCode}|${year}`];
}


/* ==========================================================================
   3. Map

   No tile layer. The only thing drawn is the boundary file, on a flat
   background set in the stylesheet. Relief, roads and place names carry no
   information about any of these indicators and compete with the one channel
   that does carry it, which is colour.
   ========================================================================== */

let map = null;
let geoLayer = null;

function initMap() {
  map = L.map('map', {
    scrollWheelZoom: false,
    zoomSnap: 0.25,
    attributionControl: true,
    preferCanvas: true          // 42,000 vertices draw faster on a canvas
  });
  map.attributionControl.addAttribution(
    'Boundaries: Líneas Límite Municipales, CC BY 4.0 <a href="https://www.ign.es/">ign.es</a>');
}

/**
 * Quantile class breaks: each colour holds the same number of municipalities.
 *
 * The alternative, equal ranges of value, would place almost every municipality
 * in the first class, because the municipality of Madrid is an order of
 * magnitude above every other one on most indicators. The price is that colour
 * then encodes position in the ranking rather than magnitude, which is what the
 * bar chart underneath the map is for.
 */
function quantileBreaks(values, classes) {
  const clean = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v))
                      .sort((a, b) => a - b);
  if (clean.length === 0) return [];
  const cuts = [];
  for (let i = 1; i < classes; i++) {
    const position = Math.floor(clean.length * i / classes);
    cuts.push(clean[Math.min(position, clean.length - 1)]);
  }
  return cuts;
}

function colourOf(value, cuts) {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_DATA;
  if (cuts.length === 0) return PALETTE[PALETTE.length - 1];
  let index = 0;
  while (index < cuts.length && value > cuts[index]) index++;
  return PALETTE[index];
}

/**
 * Draw the choropleth. `values` maps ine_code to a number. A municipality
 * absent from that object is drawn as "not published", never as zero: the
 * Ministry publishes only the larger municipalities and filling the rest with
 * zero would turn a gap in the source into a finding.
 */
function drawChoropleth(values, unit, title) {
  if (!boundaries || !map) return;

  const present = Object.values(values).filter(v => v !== null && v !== undefined);
  const cuts = quantileBreaks(present, CLASSES);

  if (geoLayer) map.removeLayer(geoLayer);

  geoLayer = L.geoJSON(boundaries, {
    style: (feature) => {
      const code = feature.properties.ine_code;
      const value = values[code];
      const hasData = value !== null && value !== undefined;
      const isSelected = code === state.selected;
      return {
        fillColor: colourOf(value, cuts),
        fillOpacity: hasData ? 0.92 : 0.5,
        color: isSelected ? ACCENT : (hasData ? '#8d99a6' : '#b9c1c9'),
        weight: isSelected ? 3 : 0.6,
        dashArray: hasData ? null : '3 3'
      };
    },
    onEachFeature: (feature, layer) => {
      const code = feature.properties.ine_code;
      const value = values[code];
      const label = (value === null || value === undefined)
        ? '<em>not published by the Ministry of the Interior</em>'
        : `<strong>${fmt(value)}</strong> ${unit}`;
      layer.bindTooltip(`<strong>${NAMES[code] || code}</strong><br>${label}`,
                        { className: 'mun-tooltip', sticky: true });
      layer.on('click', () => {
        state.selected = (state.selected === code) ? null : code;
        redraw();
      });
    }
  }).addTo(map);

  if (!map._fitted) { map.fitBounds(geoLayer.getBounds(), { padding: [8, 8] }); map._fitted = true; }

  drawLegend(cuts, unit, title, present.length);
}

function drawLegend(cuts, unit, title, count) {
  const swatch = (colour, text) =>
    `<span class="swatch"><i style="background:${colour}"></i>${text}</span>`;

  const ranges = [];
  const n = cuts.length ? CLASSES : 1;
  for (let i = 0; i < n; i++) {
    const lower = i === 0 ? null : cuts[i - 1];
    const upper = i === n - 1 ? null : cuts[i];
    let text;
    if (lower === null && upper === null) text = 'all values';
    else if (lower === null) text = `up to ${fmt(upper)}`;
    else if (upper === null) text = `more than ${fmt(lower)}`;
    else text = `${fmt(lower)} to ${fmt(upper)}`;
    ranges.push(swatch(PALETTE[cuts.length ? i : PALETTE.length - 1], text));
  }
  ranges.push(swatch(NO_DATA, 'not published'));

  $('legend').innerHTML =
    `<div class="legend-title">${title}${unit ? `, ${unit}` : ''}</div>` +
    `<div class="legend-row">${ranges.join('')}</div>`;
}


/* ==========================================================================
   4. Chart helpers
   ========================================================================== */

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: { labels: { boxWidth: 12, font: { size: 11 } } },
    title: { display: false }
  }
};

function options(extra) {
  const merged = JSON.parse(JSON.stringify(CHART_DEFAULTS));
  const plugins = Object.assign(merged.plugins, extra.plugins || {});
  return Object.assign(merged, extra, { plugins });
}

function render(canvasId, config) {
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart($(canvasId).getContext('2d'), config);
}

function clearChart(canvasId) {
  if (charts[canvasId]) { charts[canvasId].destroy(); delete charts[canvasId]; }
}

/**
 * Height for a horizontal bar chart, so that every category label is drawn.
 * Chart.js hides labels that do not fit, which on a ranking of municipalities
 * silently removes exactly the information the chart is for.
 */
function sizeForBars(count, perBar = 24, extra = 90) {
  return Math.max(260, count * perBar + extra);
}

function horizontalBarOptions(axisLabel, extra) {
  return options(Object.assign({
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: {
      x: { beginAtZero: true, title: { display: true, text: axisLabel } },
      y: { ticks: { autoSkip: false, font: { size: 11 } } }
    }
  }, extra || {}));
}


/* ==========================================================================
   5. Table: rendering, sorting, CSV export
   ========================================================================== */

const FORMATS = {
  text: (v) => (v === null || v === undefined ? '' : String(v)),
  int:  (v) => fmt(v, 0),
  dec2: (v) => fmt(v, 2),
  dec3: (v) => fmt(v, 3),
  pct1: (v) => (v === null || v === undefined ? '' : fmt(v * 100, 1) + ' %')
};

function setTable(columns, rows, config) {
  config = config || {};
  table = {
    columns, rows,
    sortKey: config.sortKey || columns[0].key,
    sortDir: config.sortDir || 'desc',
    filename: config.filename || 'indicators.csv',
    rowKey: config.rowKey || null,
    note: config.note || ''
  };
  $('table-title').textContent = config.title || 'All the numbers';
  $('table-note').innerHTML = table.note;
  drawTable();
}

function drawTable() {
  if (!table) return;
  const { columns, sortKey, sortDir } = table;

  const rows = table.rows.slice().sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const cmp = typeof x === 'string' ? x.localeCompare(y, 'es') : x - y;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const head = columns.map(c =>
    `<th data-key="${c.key}">${c.label}` +
    (c.key === sortKey ? `<span class="arrow">${sortDir === 'asc' ? '▲' : '▼'}</span>` : '') +
    '</th>').join('');

  const body = rows.map(row => {
    const key = table.rowKey ? row[table.rowKey] : null;
    const selected = key && key === state.selected ? ' class="selected"' : '';
    const cells = columns.map(c => {
      const formatter = FORMATS[c.format || 'text'];
      const numeric = (c.format || 'text') !== 'text';
      return `<td class="${numeric ? 'num' : ''}">${formatter(row[c.key])}</td>`;
    }).join('');
    return `<tr${selected} data-key="${key || ''}">${cells}</tr>`;
  }).join('');

  const element = $('data-table');
  element.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;

  element.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (table.sortKey === key) table.sortDir = table.sortDir === 'asc' ? 'desc' : 'asc';
      else { table.sortKey = key; table.sortDir = 'desc'; }
      drawTable();
    });
  });

  if (table.rowKey) {
    element.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const key = tr.dataset.key;
        if (!key) return;
        state.selected = (state.selected === key) ? null : key;
        redraw();
      });
    });
  }
}

function downloadCsv() {
  if (!table) return;
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [table.columns.map(c => escape(c.label)).join(',')];
  table.rows.forEach(row => lines.push(table.columns.map(c => escape(row[c.key])).join(',')));

  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = table.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}


/* ==========================================================================
   6. Modules
   ========================================================================== */

/* --------------------------------------------------------------------------
   Module A. Crime level
   -------------------------------------------------------------------------- */

/**
 * The weighted index, computed here because the weights are chosen on the page.
 *
 *   points(i,t) = sum over offence types c of w_c * offences(c,i,t)
 *   index(i,t)  = points(i,t) / D(i,t) * k
 *
 * With every weight equal to one this reproduces the plain rate exactly, which
 * is the check worth keeping in mind when reading the ranking.
 */
function compositeRows(year, indicatorKey, weights) {
  const spec = A_INDICATORS[indicatorKey];
  const byMunicipality = {};

  data.crime_level.forEach(r => {
    if (r.year !== year || r.denominator !== spec.denominator || r.crime_code === AGG) return;
    const entry = byMunicipality[r.ine_code] ||
                  (byMunicipality[r.ine_code] = { ine_code: r.ine_code, points: 0, offences: 0 });
    entry.points += (weights[r.crime_code] || 0) * r.offences;
    entry.offences += r.offences;
  });

  const rows = Object.values(byMunicipality);
  rows.forEach(entry => {
    entry.name = NAMES[entry.ine_code] || entry.ine_code;
    entry.denom = denomOf(entry.ine_code, year, spec.denominator);
    if (spec.scale === null) {                  // the raw count indicator
      entry.score = entry.points;
      entry.plain = entry.offences;
    } else {
      entry.score = entry.denom ? entry.points / entry.denom * spec.scale : null;
      entry.plain = entry.denom ? entry.offences / entry.denom * spec.scale : null;
    }
  });

  // Rank under the chosen weights and under equal weights, so that the effect
  // of the weighting can be read as a movement and not only as a level.
  rows.slice().sort((a, b) => b.score - a.score).forEach((e, i) => { e.rank = i + 1; });
  rows.slice().sort((a, b) => b.plain - a.plain).forEach((e, i) => { e.rankPlain = i + 1; });
  rows.forEach(e => { e.rankChange = e.rankPlain - e.rank; });

  return rows;
}

function drawA() {
  return isWeighted() ? drawAWeighted() : drawASingle();
}

function drawASingle() {
  const spec = A_INDICATORS[state.a.indicator];
  const crimeName = state.a.crime === AGG
    ? 'All offence types'
    : (meta.crimeMun[state.a.crime] || state.a.crime);

  const rows = data.crime_level.filter(r =>
    r.year === state.year && r.crime_code === state.a.crime && r.denominator === spec.denominator);

  const values = {};
  rows.forEach(r => { values[r.ine_code] = r[spec.field]; });

  $('left-title').textContent = `${crimeName}, ${state.year}`;
  drawChoropleth(values, spec.unit, crimeName);
  $('left-note').textContent = '';

  /* --- right: the selected municipality over time ---------------------- */
  const series = state.selected
    ? data.crime_level.filter(r => r.ine_code === state.selected &&
                                   r.crime_code === state.a.crime &&
                                   r.denominator === spec.denominator)
                      .sort((a, b) => a.year - b.year)
    : null;

  if (series && series.length) {
    showRight('chart');
    $('right-chart-box').style.height = '340px';
    $('right-title').textContent = `${NAMES[state.selected] || state.selected} over time`;
    render('chart-right', {
      type: 'line',
      data: {
        labels: series.map(r => r.year),
        datasets: [{
          label: spec.unit, data: series.map(r => r[spec.field]),
          borderColor: ACCENT, backgroundColor: ACCENT, tension: 0.25, pointRadius: 4
        }]
      },
      options: options({
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, title: { display: true, text: spec.unit } } }
      })
    });
    $('right-note').textContent = '';
  } else {
    showRight('empty');
    $('right-title').textContent = 'One municipality over time';
    $('right-empty').innerHTML =
      'Select a municipality to see how this indicator moved between 2019 and 2025.' +
      '<span>Click it on the map, on a bar of the ranking below, or on a row of the table.</span>';
    $('right-note').textContent = '';
  }

  /* --- wide: the ranking, every municipality, every name legible -------- */
  const ranked = rows.slice().sort((a, b) => b[spec.field] - a[spec.field]);
  $('wide-title').textContent = `Every municipality with published data, ${state.year}`;
  $('wide-box').style.height = sizeForBars(ranked.length) + 'px';

  render('chart-wide', {
    type: 'bar',
    data: {
      labels: ranked.map(r => NAMES[r.ine_code] || r.ine_code),
      datasets: [{
        label: spec.unit,
        data: ranked.map(r => r[spec.field]),
        backgroundColor: ranked.map(r => r.ine_code === state.selected ? ACCENT : PALETTE[3]),
        borderWidth: 0
      }]
    },
    options: horizontalBarOptions(spec.unit, {
      onClick: (event, elements) => {
        if (!elements.length) return;
        const code = ranked[elements[0].index].ine_code;
        state.selected = (state.selected === code) ? null : code;
        redraw();
      }
    })
  });
  $('wide-note').textContent =
    'Sorted from highest to lowest. Click a bar to select that municipality on the map ' +
    'and in the table.';

  /* --- table ------------------------------------------------------------ */
  const perMunicipality = {};
  data.crime_level
    .filter(r => r.year === state.year && r.crime_code === state.a.crime)
    .forEach(r => {
      const entry = perMunicipality[r.ine_code] ||
                    (perMunicipality[r.ine_code] = { ine_code: r.ine_code });
      entry.offences = r.offences;
      if (r.denominator === 'population') entry.per1000 = r.rate_per_1000;
      if (r.denominator === 'area') entry.perKm2 = r.rate;
    });

  const tableRows = Object.values(perMunicipality).map(entry => ({
    name: NAMES[entry.ine_code] || entry.ine_code,
    ine_code: entry.ine_code,
    population: denomOf(entry.ine_code, state.year, 'population'),
    area: AREA[entry.ine_code],
    offences: entry.offences,
    per1000: entry.per1000,
    perKm2: entry.perKm2
  }));

  setTable([
    { key: 'name', label: 'Municipality', format: 'text' },
    { key: 'ine_code', label: 'INE code', format: 'text' },
    { key: 'population', label: 'Inhabitants', format: 'int' },
    { key: 'area', label: 'Area, km²', format: 'dec2' },
    { key: 'offences', label: 'Recorded offences', format: 'int' },
    { key: 'per1000', label: 'Per 1,000 inhabitants', format: 'dec2' },
    { key: 'perKm2', label: 'Per km²', format: 'dec2' }
  ], tableRows, {
    title: `${crimeName}, ${state.year}, all the numbers`,
    sortKey: { per1000: 'per1000', perkm2: 'perKm2', count: 'offences' }[state.a.indicator],
    rowKey: 'ine_code',
    filename: `crime_level_${state.a.crime}_${state.year}.csv`,
    note: 'One row per municipality with published data. Click a row to select it on the map. ' +
          'Click a column heading to sort by it.'
  });
}

function drawAWeighted() {
  const spec = A_INDICATORS[state.a.indicator];
  const rows = compositeRows(state.year, state.a.indicator, state.a.weights);

  const values = {};
  rows.forEach(r => { values[r.ine_code] = r.score; });

  $('left-title').textContent = `Weighted index, ${state.year}`;
  drawChoropleth(values, spec.weightedUnit, 'Weighted index');
  $('left-note').textContent = '';

  /* --- right: the weight editor instead of a chart --------------------- */
  showRight('weights');
  $('right-title').textContent = 'Choose how much each offence type counts';

  const movers = rows.slice().sort((a, b) => Math.abs(b.rankChange) - Math.abs(a.rankChange))
                     .filter(r => r.rankChange !== 0).slice(0, 3);
  $('right-note').innerHTML = movers.length
    ? 'Largest movements caused by your weights: ' +
      movers.map(r => `<strong>${r.name}</strong> ${r.rankChange > 0 ? 'up' : 'down'} ` +
                      `${Math.abs(r.rankChange)}`).join(', ') + '.'
    : 'Your weights do not change the ranking at all. That is what happens when every offence ' +
      'type has the same weight, and it is the check that the index is doing what it should.';

  /* --- wide: the ranking under the chosen weights ---------------------- */
  const ranked = rows.slice().sort((a, b) => b.score - a.score);
  $('wide-title').textContent = `Ranking under your weights, ${state.year}`;
  $('wide-box').style.height = sizeForBars(ranked.length) + 'px';

  render('chart-wide', {
    type: 'bar',
    data: {
      labels: ranked.map(r => r.name),
      datasets: [
        { label: 'with your weights', data: ranked.map(r => r.score),
          backgroundColor: ranked.map(r => r.ine_code === state.selected ? ACCENT : PALETTE[4]),
          borderWidth: 0 },
        { label: 'every offence counts one', data: ranked.map(r => r.plain),
          backgroundColor: PALETTE[2], borderWidth: 0 }
      ]
    },
    options: horizontalBarOptions(spec.weightedUnit, {
      plugins: { legend: { display: true, position: 'top' } },
      onClick: (event, elements) => {
        if (!elements.length) return;
        const code = ranked[elements[0].index].ine_code;
        state.selected = (state.selected === code) ? null : code;
        redraw();
      }
    })
  });
  $('wide-note').textContent =
    'The pale bar is the same municipality with every offence counted once. Where the two bars ' +
    'differ, the weighting is doing something.';

  /* --- table ------------------------------------------------------------ */
  const denomLabel = spec.denominator === 'population' ? 'Inhabitants' : 'Area, km²';
  setTable([
    { key: 'name', label: 'Municipality', format: 'text' },
    { key: 'ine_code', label: 'INE code', format: 'text' },
    { key: 'denom', label: denomLabel, format: spec.denominator === 'population' ? 'int' : 'dec2' },
    { key: 'offences', label: 'Recorded offences', format: 'int' },
    { key: 'points', label: 'Weighted points', format: 'dec2' },
    { key: 'score', label: 'Weighted index', format: 'dec2' },
    { key: 'plain', label: 'Unweighted', format: 'dec2' },
    { key: 'rank', label: 'Rank, weighted', format: 'int' },
    { key: 'rankPlain', label: 'Rank, unweighted', format: 'int' },
    { key: 'rankChange', label: 'Places gained', format: 'int' }
  ], rows, {
    title: `Weighted index, ${state.year}, all the numbers`,
    sortKey: 'score',
    rowKey: 'ine_code',
    filename: `crime_level_weighted_${state.year}.csv`,
    note: 'Weighted points is the sum over offence types of your weight times the number of ' +
          'offences. The index divides it by population or area. Places gained is positive when ' +
          'your weights move a municipality up the ranking.'
  });
}


/* --------------------------------------------------------------------------
   Module B. Police performance
   -------------------------------------------------------------------------- */

function drawB() {
  const name = meta.crimeReg[state.b.crime] ? meta.crimeReg[state.b.crime].name_en : state.b.crime;
  const indicator = B_INDICATORS[state.b.indicator];

  const series = data.police_performance
    .filter(r => r.crime_code === state.b.crime)
    .sort((a, b) => a.year - b.year);

  /* --- left: the chosen indicator, year by year ------------------------
     This chart follows the Indicator control. Cleared and unsolved offences
     are parts of the recorded total, so when one of them is chosen the total
     is drawn behind it in a pale bar: without it, a fall in cleared offences
     looks like worse policing even when it is simply fewer offences. */
  $('left-title').textContent = `${name}, ${indicator.label.toLowerCase()} by year`;
  $('left-chart-box').style.height = '340px';

  if (state.b.indicator === 'clearance_rate') {
    render('chart-left', {
      type: 'line',
      data: {
        labels: series.map(r => r.year),
        datasets: [{
          label: 'Clearance rate, %',
          data: series.map(r => r.clearance_rate === null ? null : r.clearance_rate * 100),
          borderColor: ACCENT, backgroundColor: ACCENT, tension: 0.25,
          pointRadius: series.map(r => r.clearance_above_one ? 8 : 4),
          pointStyle: series.map(r => r.clearance_above_one ? 'triangle' : 'circle')
        }]
      },
      options: options({
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true,
                       title: { display: true, text: 'per cent of recorded offences cleared' } } }
      })
    });
  } else {
    const datasets = [{
      label: indicator.label,
      data: series.map(r => r[state.b.indicator]),
      backgroundColor: PALETTE[4], borderWidth: 0, order: 1
    }];
    if (state.b.indicator !== 'recorded') {
      datasets.push({
        label: 'Recorded, for reference',
        data: series.map(r => r.recorded),
        backgroundColor: PALETTE[2], borderWidth: 0, order: 2
      });
    }
    render('chart-left', {
      type: 'bar',
      data: { labels: series.map(r => r.year), datasets },
      options: options({
        plugins: { legend: { display: datasets.length > 1 } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'offences' } } }
      })
    });
  }

  /* --- right: what the unsolved case load is made of ------------------- */
  const composition = data.police_performance
    .filter(r => r.year === state.year && r.level === state.b.level && r.unsolved > 0)
    .sort((a, b) => b.unsolved - a.unsolved);

  const top = composition.slice(0, 7);
  const rest = composition.slice(7).reduce((sum, r) => sum + r.unsolved, 0);
  const doughnutColours = ['#2c5c96', '#5a86ba', '#8fb0d3', '#c3d4e6', '#b03a2e',
                           '#c2708a', '#7f8fa0', '#d9d9d9'];

  showRight('chart');
  $('right-chart-box').style.height = '340px';
  $('right-title').textContent = `What is unsolved in ${state.year}`;
  render('chart-right', {
    type: 'doughnut',
    data: {
      labels: top.map(r => meta.crimeReg[r.crime_code] ? meta.crimeReg[r.crime_code].name_en : r.crime_code)
                 .concat(rest > 0 ? ['All other categories'] : []),
      datasets: [{
        data: top.map(r => r.unsolved).concat(rest > 0 ? [rest] : []),
        backgroundColor: doughnutColours,
        borderWidth: 1, borderColor: '#fff'
      }]
    },
    options: options({
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (context) => {
          const total = context.dataset.data.reduce((s, v) => s + v, 0);
          return `${context.label}: ${fmt(context.parsed, 0)} offences, ` +
                 `${fmt(context.parsed / total * 100, 1)} %`;
        } } }
      }
    })
  });
  $('right-note').textContent = '';

  /* --- wide: the chosen indicator by category, all names legible ------- */
  const byCategory = data.police_performance
    .filter(r => r.year === state.year && r.level === state.b.level && r.recorded > 0)
    .map(r => ({
      code: r.crime_code,
      name: meta.crimeReg[r.crime_code] ? meta.crimeReg[r.crime_code].name_en : r.crime_code,
      value: indicator.percent ? (r.clearance_rate || 0) * 100 : r[state.b.indicator]
    }))
    .sort((a, b) => b.value - a.value);

  $('wide-title').textContent =
    `${indicator.label} by category, level ${state.b.level}, ${state.year}`;
  $('wide-box').style.height = sizeForBars(byCategory.length, 26) + 'px';

  render('chart-wide', {
    type: 'bar',
    data: {
      labels: byCategory.map(r => r.name),
      datasets: [{
        label: indicator.unit,
        data: byCategory.map(r => r.value),
        backgroundColor: PALETTE[3],
        borderWidth: 0
      }]
    },
    options: horizontalBarOptions(indicator.unit, {
      onClick: (event, elements) => {
        if (!elements.length) return;
        state.b.crime = byCategory[elements[0].index].code;
        $('b-crime').value = state.b.crime;
        redraw();
      }
    })
  });
  $('wide-note').textContent =
    'Click a bar to load that category into the chart above. Only categories with at least one ' +
    'recorded offence are drawn.';

  /* --- table ------------------------------------------------------------ */
  const tableRows = data.police_performance
    .filter(r => r.year === state.year)
    .map(r => ({
      name: meta.crimeReg[r.crime_code] ? meta.crimeReg[r.crime_code].name_en : r.crime_code,
      code: r.crime_code,
      level: r.level,
      recorded: r.recorded,
      cleared: r.cleared,
      unsolved: r.unsolved,
      clearance: r.clearance_rate,
      shareInLevel: r.unsolved_share_in_level
    }));

  setTable([
    { key: 'name', label: 'Offence category', format: 'text' },
    { key: 'code', label: 'Code', format: 'text' },
    { key: 'level', label: 'Level', format: 'int' },
    { key: 'recorded', label: 'Recorded', format: 'int' },
    { key: 'cleared', label: 'Cleared', format: 'int' },
    { key: 'unsolved', label: 'Unsolved', format: 'int' },
    { key: 'clearance', label: 'Clearance rate', format: 'pct1' },
    { key: 'shareInLevel', label: 'Share of unsolved in its level', format: 'pct1' }
  ], tableRows, {
    title: `Police performance, ${state.year}, all 44 categories`,
    sortKey: 'recorded',
    filename: `police_performance_${state.year}.csv`,
    note: 'Level 0 is the total for the region, level 1 the twelve main categories, levels 2 and 3 ' +
          'their subdivisions. Rows of different levels overlap, so do not add them together.'
  });
}


/* --------------------------------------------------------------------------
   Module C. Victims and offenders

   Two charts, one above the other and each the full width of the page. The
   pyramid needs the width for its two facing axes and the comparison needs it
   for four series across five age bands; side by side, both were cramped.
   -------------------------------------------------------------------------- */

function demographicRows(measure) {
  return data.demographic_profile.filter(r =>
    r.measure === measure && r.year === state.year && r.crime_code === state.c.crime);
}

function drawC() {
  const name = meta.crimeReg[state.c.crime] ? meta.crimeReg[state.c.crime].name_en : state.c.crime;
  const field = state.c.indicator;                  // 'cases' or 'share'
  const unitLabel = field === 'share' ? 'per cent of the total' : 'people';
  const scale = field === 'share' ? 100 : 1;

  /* --- top: the pyramid ------------------------------------------------- */
  const bands = demographicRows(state.c.measure).filter(r => !r.is_age_total);
  const ages = AGE_ORDER.filter(a => bands.some(r => r.age === a));
  const pick = (age, sex) => {
    const row = bands.find(r => r.age === age && r.sex === sex);
    return row ? (row[field] || 0) * scale : 0;
  };

  $('left-title').textContent =
    `${state.c.measure === 'victims' ? 'Victims' : 'Arrested or investigated persons'}, ` +
    `${name}, ${state.year}`;
  $('left-chart-box').style.height = '420px';

  render('chart-left', {
    type: 'bar',
    data: {
      labels: ages.map(a => AGE_LABEL[a] || a),
      datasets: [
        { label: 'Male', data: ages.map(a => -pick(a, 'M')), backgroundColor: PALETTE[4] },
        { label: 'Female', data: ages.map(a => pick(a, 'F')), backgroundColor: PINK }
      ]
    },
    options: options({
      indexAxis: 'y',
      plugins: {
        tooltip: { callbacks: { label: (context) =>
          `${context.dataset.label}: ${fmt(Math.abs(context.parsed.x))} ${unitLabel}` } }
      },
      scales: {
        x: { stacked: true, title: { display: true, text: unitLabel },
             ticks: { callback: (v) => fmt(Math.abs(v)) } },
        y: { stacked: true, ticks: { autoSkip: false }, title: { display: true, text: 'age band' } }
      }
    })
  });

  const unknownSex = bands.filter(r => r.sex === 'U').reduce((sum, r) => sum + (r.cases || 0), 0);
  $('left-note').textContent = unknownSex
    ? `Records of unknown sex are not drawn: ${fmt(unknownSex, 0)} in this selection.`
    : 'No record of unknown sex in this selection.';

  /* --- bottom: victims against arrested persons ------------------------- */
  const totalIn = (measure, age, sex) => demographicRows(measure)
    .filter(r => r.age === age && r.sex === sex)
    .reduce((sum, r) => sum + (r[field] || 0), 0) * scale;

  showRight('chart');
  $('right-chart-box').style.height = '420px';
  $('right-title').textContent = 'Victims compared with arrested or investigated persons';

  render('chart-right', {
    type: 'bar',
    data: {
      labels: COMPARABLE_BANDS,
      datasets: [
        { label: 'Victims, male', data: COMPARABLE_BANDS.map(a => totalIn('victims', a, 'M')),
          backgroundColor: PALETTE[2] },
        { label: 'Victims, female', data: COMPARABLE_BANDS.map(a => totalIn('victims', a, 'F')),
          backgroundColor: '#e0b6c4' },
        { label: 'Arrested, male', data: COMPARABLE_BANDS.map(a => totalIn('offenders', a, 'M')),
          backgroundColor: PALETTE[4] },
        { label: 'Arrested, female', data: COMPARABLE_BANDS.map(a => totalIn('offenders', a, 'F')),
          backgroundColor: PINK }
      ]
    },
    options: options({
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { title: { display: true, text: 'age band' }, ticks: { autoSkip: false } },
        y: { beginAtZero: true, title: { display: true, text: unitLabel } }
      }
    })
  });
  $('right-note').textContent =
    'Only the five age bands that both series cover. Victims are recorded from age zero and ' +
    'arrested or investigated persons from age fourteen.';

  /* --- table ------------------------------------------------------------ */
  const tableRows = data.demographic_profile
    .filter(r => r.year === state.year && r.crime_code === state.c.crime)
    .map(r => ({
      measure: r.measure === 'victims' ? 'Victims' : 'Arrested or investigated',
      age: r.is_age_total ? 'All ages' : (AGE_LABEL[r.age] || r.age),
      sex: SEX_LABEL[r.sex] || r.sex,
      cases: r.cases,
      share: r.share,
      rate: r.rate_per_10000,
      comparable: r.comparable_band ? 'yes' : 'no'
    }));

  setTable([
    { key: 'measure', label: 'People counted', format: 'text' },
    { key: 'age', label: 'Age band', format: 'text' },
    { key: 'sex', label: 'Sex', format: 'text' },
    { key: 'cases', label: 'People', format: 'int' },
    { key: 'share', label: 'Share of the total', format: 'pct1' },
    { key: 'rate', label: 'Per 10,000 inhabitants of that sex', format: 'dec2' },
    { key: 'comparable', label: 'Comparable band', format: 'text' }
  ], tableRows, {
    title: `${name}, ${state.year}, all the numbers`,
    sortKey: 'cases',
    filename: `demographic_profile_${state.c.crime}_${state.year}.csv`,
    note: 'Both populations are listed, so that the comparison in the lower chart can be checked ' +
          'number by number. The rate per 10,000 is filled in only for the All ages rows, because ' +
          'the population behind it is available by sex and not by age band. Shares of the age ' +
          'bands add to 100 per cent on their own, and so do the shares of the All ages rows, so ' +
          'do not add the two together.'
  });
}


/* --------------------------------------------------------------------------
   Module D. Crime structure
   -------------------------------------------------------------------------- */

/** Share of each offence type, for one municipality or for all of them. */
function offenceMix(year, ineCode) {
  const counts = {};
  data.crime_level.forEach(r => {
    if (r.year !== year || r.denominator !== 'population' || r.crime_code === AGG) return;
    if (ineCode && r.ine_code !== ineCode) return;
    counts[r.crime_code] = (counts[r.crime_code] || 0) + r.offences;
  });
  const total = Object.values(counts).reduce((sum, v) => sum + v, 0);
  return meta.crime_types_mun
    .map(t => ({
      code: t.code, name: t.name_en, violence: t.violence,
      offences: counts[t.code] || 0,
      share: total ? (counts[t.code] || 0) / total : 0
    }))
    .sort((a, b) => b.share - a.share);
}

function drawD() {
  const indicator = D_INDICATORS[state.d.indicator];
  const rows = data.crime_structure.filter(r => r.year === state.year);

  const values = {};
  rows.forEach(r => { values[r.ine_code] = r[state.d.indicator]; });

  $('left-title').textContent = `${indicator.label}, ${state.year}`;
  drawChoropleth(values, indicator.unit, indicator.label);
  $('left-note').textContent = indicator.plain;

  /* --- right: the offence mix itself ------------------------------------
     This replaces the scatter plot that used to sit here. Entropy, violent
     share and unclassified share are all summaries of one thing, the mix of
     offence types, and showing the mix is easier to read than any summary of
     it. The bars are coloured by violence class, so the violent share and the
     unclassified share can be seen directly. */
  const mix = offenceMix(state.year, state.selected);
  const mixColour = (v) => v === 'violent' ? ACCENT : v === 'non_violent' ? PALETTE[4] : GREY;

  showRight('chart');
  $('right-chart-box').style.height = sizeForBars(mix.length, 26, 70) + 'px';
  $('right-title').textContent = state.selected
    ? `What the offences are, ${NAMES[state.selected] || state.selected}, ${state.year}`
    : `What the offences are, all published municipalities, ${state.year}`;

  render('chart-right', {
    type: 'bar',
    data: {
      labels: mix.map(m => m.name),
      datasets: [{
        label: 'per cent of recorded offences',
        data: mix.map(m => m.share * 100),
        backgroundColor: mix.map(m => mixColour(m.violence)),
        borderWidth: 0
      }]
    },
    options: horizontalBarOptions('per cent of recorded offences', {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => {
          const m = mix[context.dataIndex];
          return `${fmt(m.share * 100, 1)} % of offences, ${fmt(m.offences, 0)} recorded`;
        } } }
      }
    })
  });

  const selectedRow = state.selected ? rows.find(r => r.ine_code === state.selected) : null;
  $('right-note').innerHTML =
    `<span class="key"><i style="background:${ACCENT}"></i>violent` +
    `<i style="background:${PALETTE[4]}"></i>non violent` +
    `<i style="background:${GREY}"></i>cannot be classified</span><br>` +
    (selectedRow
      ? `<strong>This chart is showing ${NAMES[state.selected]} alone</strong>, because it is ` +
        'selected on the map. Click it again, or use Clear selection above the map, to go back ' +
        `to all municipalities together. Here the grey bar is ` +
        `${fmt(selectedRow.unclassified_share * 100, 1)} per cent of all offences and the violent ` +
        'share is computed over the rest. The more even the bars, the higher the variety.'
      : '<strong>Click a municipality on the map, on the ranking below or in the table, and this ' +
        'chart shows that municipality alone.</strong>');

  /* --- wide: the ranking ------------------------------------------------ */
  const ranked = rows.filter(r => r[state.d.indicator] !== null && r[state.d.indicator] !== undefined)
                     .sort((a, b) => b[state.d.indicator] - a[state.d.indicator]);
  $('wide-title').textContent = `Every municipality with published data, ${state.year}`;
  $('wide-box').style.height = sizeForBars(ranked.length) + 'px';

  render('chart-wide', {
    type: 'bar',
    data: {
      labels: ranked.map(r => NAMES[r.ine_code] || r.ine_code),
      datasets: [{
        label: indicator.label,
        data: ranked.map(r => r[state.d.indicator]),
        backgroundColor: ranked.map(r => r.ine_code === state.selected ? ACCENT : PALETTE[3]),
        borderWidth: 0
      }]
    },
    options: horizontalBarOptions(indicator.unit, {
      onClick: (event, elements) => {
        if (!elements.length) return;
        const code = ranked[elements[0].index].ine_code;
        state.selected = (state.selected === code) ? null : code;
        redraw();
      }
    })
  });
  $('wide-note').textContent =
    'Click a bar to load that municipality into the chart beside the map.';

  /* --- table ------------------------------------------------------------ */
  const tableRows = rows.map(r => Object.assign({ name: NAMES[r.ine_code] || r.ine_code }, r));

  setTable([
    { key: 'name', label: 'Municipality', format: 'text' },
    { key: 'ine_code', label: 'INE code', format: 'text' },
    { key: 'population', label: 'Inhabitants', format: 'int' },
    { key: 'total', label: 'Offences', format: 'int' },
    { key: 'violent', label: 'Violent', format: 'int' },
    { key: 'non_violent', label: 'Non violent', format: 'int' },
    { key: 'unclassified', label: 'Cannot be classified', format: 'int' },
    { key: 'crime_types_count', label: 'Offence types present', format: 'int' },
    { key: 'violent_share', label: 'Violent share', format: 'pct1' },
    { key: 'violent_ratio', label: 'Violent per non violent', format: 'dec3' },
    { key: 'unclassified_share', label: 'Share not classified', format: 'pct1' },
    { key: 'shannon', label: 'Shannon entropy', format: 'dec3' },
    { key: 'shannon_normalised', label: 'Variety, 0 to 1', format: 'dec3' }
  ], tableRows, {
    title: `Crime structure, ${state.year}, all the numbers`,
    sortKey: 'total',
    rowKey: 'ine_code',
    filename: `crime_structure_${state.year}.csv`,
    note: 'Violent, non violent and cannot be classified add up to the offence count. The violent ' +
          'share is computed over the first two only. Offence types present is filled in only if ' +
          'the export was produced by the corrected indicators script.'
  });
}


/* ==========================================================================
   7. Methodology tab
   ========================================================================== */

function drawMethodology() {
  const years = meta.yearsOf('A');
  const withData = {};
  data.crime_level
    .filter(r => r.denominator === 'population' && r.crime_code === AGG)
    .forEach(r => { (withData[r.year] || (withData[r.year] = new Set())).add(r.ine_code); });

  const total = meta.municipalities.length;
  const rows = years.map(y => {
    const n = withData[y] ? withData[y].size : 0;
    return `<tr><td>${y}</td><td>${n}</td><td>${total - n}</td>` +
           `<td>${fmt(n / total * 100, 1)} %</td></tr>`;
  }).join('');

  $('coverage-table').innerHTML =
    '<table class="plain"><thead><tr><th>Year</th>' +
    '<th>Municipalities with published crime data</th>' +
    '<th>Without</th><th>Coverage</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;

  $('modules-table').innerHTML = ['A', 'B', 'C', 'D'].map(key => {
    const module = meta.modules[key];
    const hasMap = module.geography === 'municipality';
    return `<tr><td>${key}. ${module.name}</td>` +
           `<td>${hasMap ? 'Municipality' : 'Whole region'}</td>` +
           `<td>${module.years[0]} to ${module.years[1]}</td>` +
           `<td>${hasMap ? 'yes' : 'no, one figure for the region'}</td></tr>`;
  }).join('');
}


/* ==========================================================================
   8. Controls and start up
   ========================================================================== */

function moduleHasMap() { return state.module === 'A' || state.module === 'D'; }

/** What the right hand panel holds: a chart, the weight editor, or a prompt. */
function showRight(what) {
  $('right-chart-box').hidden = what !== 'chart';
  $('weights-panel').hidden = what !== 'weights';
  $('right-empty').hidden = what !== 'empty';
  if (what !== 'chart') clearChart('chart-right');
}

function syncYearSelector() {
  if (state.module === 'M') { $('ctrl-year').hidden = true; return; }
  $('ctrl-year').hidden = false;

  const years = meta.yearsOf(state.module);
  if (state.year === null || !years.includes(state.year)) {
    const target = state.year === null ? years[years.length - 1] : state.year;
    state.year = years.reduce((best, y) =>
      Math.abs(y - target) < Math.abs(best - target) ? y : best, years[0]);
  }

  const select = $('year');
  select.innerHTML = '';
  years.slice().reverse().forEach(y => select.add(new Option(y, y)));
  select.value = state.year;
}

function drawIntro() {
  const info = MODULE_INFO[state.module];
  $('intro-title').textContent = info.title;
  $('intro-lead').textContent = info.lead;
  $('intro-points').innerHTML = info.points.map(p => `<li>${p}</li>`).join('');
  $('intro-points').hidden = info.points.length === 0;

  const note = currentIndicatorNote();
  if (note) $('intro-points').innerHTML += `<li class="current">${note}</li>`;

  $('intro-formula').hidden = !info.formula;
  $('intro-formula-body').innerHTML = info.formula;
}

function redraw() {
  const main = document.querySelector('main');
  main.classList.toggle('methodology', state.module === 'M');
  main.classList.toggle('stacked', state.module === 'C');
  $('methodology').hidden = state.module !== 'M';
  $('panel-wide').hidden = state.module === 'C';

  document.querySelectorAll('.module-controls').forEach(block => {
    block.hidden = block.dataset.module !== state.module;
  });
  document.querySelectorAll('#tabs button').forEach(button => {
    button.classList.toggle('active', button.dataset.module === state.module);
  });

  drawIntro();

  if (state.module === 'M') { drawMethodology(); updateFooter(); return; }

  const weighted = $('a-weighted');
  weighted.classList.toggle('on', state.a.weighted);
  weighted.setAttribute('aria-pressed', String(state.a.weighted));
  $('a-crime').disabled = state.a.weighted;

  // The selection is sticky by design, so there has to be a visible way out of
  // it that does not require remembering which municipality was clicked.
  const clear = $('clear-selection');
  clear.hidden = !(moduleHasMap() && state.selected);
  if (!clear.hidden) clear.textContent = `Clear ${NAMES[state.selected] || state.selected}`;

  const showMap = moduleHasMap() && boundaries;
  $('map').hidden = !showMap;
  $('map-missing').hidden = !(moduleHasMap() && !boundaries);
  $('legend').hidden = !showMap;
  $('left-chart-box').hidden = moduleHasMap();
  if (moduleHasMap()) clearChart('chart-left');

  clearChart('chart-wide');

  if (state.module === 'A') drawA();
  if (state.module === 'B') drawB();
  if (state.module === 'C') drawC();
  if (state.module === 'D') drawD();

  if (showMap) setTimeout(() => map.invalidateSize(), 0);
  updateFooter();
}

function updateFooter() {
  if (state.module === 'B' || state.module === 'C') {
    $('coverage-note').textContent =
      'These figures cover the whole Community of Madrid. The source publishes no municipal ' +
      'breakdown for this module, which is why there is no map.';
    return;
  }
  const codes = new Set(
    data.crime_level.filter(r => r.year === state.year && r.denominator === 'population')
                    .map(r => r.ine_code));
  $('coverage-note').textContent =
    `${codes.size} of ${meta.municipalities.length} municipalities have crime data published ` +
    `for ${state.year}. The rest are shown as "not published", never as zero.`;
}

function buildWeightEditor() {
  const container = $('weight-inputs');
  container.innerHTML = '';
  meta.crime_types_mun.forEach(type => {
    const colour = type.violence === 'violent' ? ACCENT
                 : type.violence === 'non_violent' ? PALETTE[4] : GREY;
    const row = document.createElement('div');
    row.className = 'weight-row';
    row.innerHTML =
      `<span class="name"><span class="swatch-dot" style="background:${colour}"></span>${type.name_en}</span>` +
      `<input type="number" min="0" step="0.5" value="${state.a.weights[type.code] ?? 1}" ` +
      `data-code="${type.code}" aria-label="Weight for ${type.name_en}">`;
    container.appendChild(row);
  });
}

function applyPreset(name) {
  const fn = PRESETS[name];
  meta.crime_types_mun.forEach(t => { state.a.weights[t.code] = fn(t); });
  buildWeightEditor();
  redraw();
}

function readWeights() {
  $('weight-inputs').querySelectorAll('input').forEach(input => {
    const value = parseFloat(input.value);
    state.a.weights[input.dataset.code] = Number.isFinite(value) && value >= 0 ? value : 0;
  });
}

function buildMenus() {
  const crimeSelect = $('a-crime');
  crimeSelect.innerHTML = '';
  crimeSelect.add(new Option('All offence types', AGG));
  meta.crime_types_mun.forEach(t => crimeSelect.add(new Option(t.name_en, t.code)));
  crimeSelect.value = state.a.crime;

  const regional = meta.crime_types_reg.slice()
    .sort((a, b) => a.level - b.level ||
                    a.code.localeCompare(b.code, 'en', { numeric: true }));

  ['b-crime', 'c-crime'].forEach(id => {
    const select = $(id);
    select.innerHTML = '';
    [0, 1, 2, 3].forEach(level => {
      const group = regional.filter(t => t.level === level);
      if (!group.length) return;
      const optgroup = document.createElement('optgroup');
      optgroup.label = level === 0 ? 'Everything' : `Level ${level}`;
      group.forEach(t => optgroup.appendChild(
        new Option(level === 0 ? t.name_en : `${t.code}. ${t.name_en}`, t.code)));
      select.appendChild(optgroup);
    });
    select.value = 'TOTAL';
  });
}

function wireControls() {
  $('year').addEventListener('change', e => { state.year = Number(e.target.value); redraw(); });

  document.querySelectorAll('#tabs button').forEach(button => {
    button.addEventListener('click', () => {
      state.module = button.dataset.module;
      syncYearSelector();
      redraw();
    });
  });

  $('a-indicator').addEventListener('change', e => { state.a.indicator = e.target.value; redraw(); });
  $('a-crime').addEventListener('change', e => { state.a.crime = e.target.value; redraw(); });
  $('a-weighted').addEventListener('click', () => { state.a.weighted = !state.a.weighted; redraw(); });

  $('b-indicator').addEventListener('change', e => { state.b.indicator = e.target.value; redraw(); });
  $('b-crime').addEventListener('change', e => { state.b.crime = e.target.value; redraw(); });
  $('b-level').addEventListener('change', e => { state.b.level = Number(e.target.value); redraw(); });

  $('c-indicator').addEventListener('change', e => { state.c.indicator = e.target.value; redraw(); });
  $('c-measure').addEventListener('change', e => { state.c.measure = e.target.value; redraw(); });
  $('c-crime').addEventListener('change', e => { state.c.crime = e.target.value; redraw(); });

  $('d-indicator').addEventListener('change', e => { state.d.indicator = e.target.value; redraw(); });

  $('apply-weights').addEventListener('click', () => { readWeights(); redraw(); });
  document.querySelectorAll('button.preset').forEach(button => {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  });

  $('clear-selection').addEventListener('click', () => { state.selected = null; redraw(); });
  $('download-csv').addEventListener('click', downloadCsv);
}

async function start() {
  try {
    banner('Loading the indicator tables…');

    meta = await loadJson('data/meta.json');
    meta.crimeMun = Object.fromEntries(meta.crime_types_mun.map(t => [t.code, t.name_en]));
    meta.crimeReg = Object.fromEntries(meta.crime_types_reg.map(t => [t.code, t]));
    meta.yearsOf = function (moduleKey) {
      const [first, last] = this.modules[moduleKey].years;
      const years = [];
      for (let y = first; y <= last; y++) years.push(y);
      return years;
    };

    NAMES = Object.fromEntries(meta.municipalities.map(m => [m.ine_code, titleCase(m.name)]));
    AREA = Object.fromEntries(meta.municipalities.map(m => [m.ine_code, m.surface_km2]));

    const [crimeLevel, police, demographic, structure] = await Promise.all([
      loadTable('crime_level'),
      loadTable('police_performance'),
      loadTable('demographic_profile'),
      loadTable('crime_structure')
    ]);
    data.crime_level = crimeLevel;
    data.police_performance = police;
    data.demographic_profile = demographic;
    data.crime_structure = structure;
    normalise();

    // The population denominator lives in the crime structure table, which
    // covers exactly the municipalities that have crime data.
    POP = {};
    data.crime_structure.forEach(r => { POP[`${r.ine_code}|${r.year}`] = r.population; });

    // The boundary file is optional. Without it every chart and the table still
    // work, so a missing GeoJSON degrades the page instead of breaking it.
    try {
      boundaries = await loadJson('data/madrid_municipalities.geojson');
      boundaries.features.forEach(f => {
        if (f.properties && f.properties.ine_code && f.properties.name) {
          NAMES[f.properties.ine_code] = f.properties.name;
        }
      });
      initMap();
    } catch (error) {
      boundaries = null;
      console.warn('Boundary file not loaded:', error.message);
    }

    meta.crime_types_mun.forEach(t => { state.a.weights[t.code] = PRESETS.severity(t); });

    buildMenus();
    buildWeightEditor();
    wireControls();
    syncYearSelector();
    redraw();
    hideBanner();

  } catch (error) {
    banner(`The page could not load its data: ${error.message}. ` +
           'If you opened index.html by double clicking it, that is the cause: browsers block ' +
           'fetch for files opened from disk. Serve the folder with "python -m http.server" and ' +
           'open http://localhost:8000 instead.', true);
    console.error(error);
  }
}

start();
