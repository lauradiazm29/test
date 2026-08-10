'use strict';

// 1. Constants

const PALETTE = ['#eef3f8', '#c3d4e6', '#8fb0d3', '#5a86ba', '#2c5c96'];
const CRIME_COLOUR = {
  BURGLARY:         '#E69F00',
  VEHICLE_THEFT:    '#0072B2',
  INJURY:           '#009E73',
  THEFT:            '#56B4E9',
  ROBBERY_VIOLENT:  '#D55E00',
  SEXUAL:           '#CC79A7',
  DRUG_TRAFFICKING: '#6A51A3',
  OTHER:            '#7F6A55' 
};
const NO_DATA = '#d9d9d9';
const ACCENT  = '#b03a2e';
const PINK    = '#c2708a';
const GREY    = '#9aa5b1';
const CLASSES = 5;
const AGG = 'ALL_COMPARABLE';
const AGE_ORDER = ['0-13', '14-17', '18-30', '31-40', '41-64', '65+', 'U'];
const AGE_LABEL = { U: 'unknown age' };
const SEX_LABEL = { M: 'Male', F: 'Female', U: 'Unknown' };
const COMPARABLE_BANDS = ['14-17', '18-30', '31-40', '41-64', '65+'];
const MIN_OFFENCES = 20;

const A_INDICATORS = {
  per1000: { field: 'rate_per_1000', denominator: 'population', scale: 1000,
             unit: 'offences per 1,000 inhabitants',
             weightedUnit: 'weighted points per 1,000 inhabitants',
             label: 'offences per 1,000 inhabitants',
             note: 'For every thousand people living there, this many offences were recorded in the year.'},
  perkm2:  { field: 'rate', denominator: 'area', scale: 1,
             unit: 'offences per km²',
             weightedUnit: 'weighted points per km²',
             label: 'offences per km²',
             note: 'How concentrated crime is in space, so dense urban municipalities score high.'},
  count:   { field: 'offences', denominator: 'population', scale: null,
             unit: 'recorded offences',
             weightedUnit: 'weighted points',
             label: 'the number of recorded offences',
             note: 'Raw count: bigger municipalities have bigger numbers almost by definition.'}
};

const B_INDICATORS = {
  clearance_rate: {label: 'Clearance rate', unit: 'clearance rate, %', percent: true},
  unsolved: {label: 'Unsolved offences', unit: 'unsolved offences'},
  recorded: {label: 'Recorded offences', unit: 'recorded offences'},
  cleared: {label: 'Cleared offences', unit: 'cleared offences'}
};

const D_INDICATORS = {
  violent_share: {label: 'Violent share', unit: 'share of classified offences',
    plain: 'The fraction that are violent.'},
  violent_ratio: {label: 'Violent to non violent ratio', unit: 'violent per non violent offence',
    plain: 'How many violent offences there are for each non violent one.'},
  shannon_normalised: {label: 'Variety of offences, normalised', unit: '0 to 1',
    plain: 'Close to 0 means one or two offence types dominate; close to 1 means offences are spread evenly across the types present.'},
  shannon: {label: 'Variety of offences, Shannon entropy', unit: 'nats',
    plain: 'Measures how diverse the offence mix is. Higher values mean the offences are distributed across more types rather than concentrated in a few.'},
  unclassified_share: {label: 'Share that cannot be classified', unit: 'share of all offences',
    plain: 'The fraction of offences that fall in the residual category.'},
  specialisation: { label: 'Offence the municipality stands out in',
    unit: 'location quotient',
    plain: 'The offence type that takes a larger share of this municipality\'s offence mix than it takes across every published municipality.' }
};

const PRESETS = {
  uniform:  () => 1,
  severity: (t) => ({
    HOM_COMPLETED: 5, HOM_ATTEMPTED: 4, KIDNAPPING: 4, SEXUAL: 4,
    INJURY: 3, ROBBERY_VIOLENT: 3, BURGLARY: 2, VEHICLE_THEFT: 2,
    DRUG_TRAFFICKING: 2, THEFT: 1, OTHER: 1
  })[t.code] ?? 1,
  violent:  (t) => (t.violence === 'violent' ? 1 : 0)
};

const VIOLENCE_COLOUR = { violent: ACCENT, non_violent: PALETTE[4] };

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
const charts = {};
let meta = null;
let boundaries = null;
let table = null;
let NAMES = {};
let AREA = {};
let POP = {};

const $ = (id) => document.getElementById(id);
const setText = (id, value) => { $(id).textContent = value; };
const setHtml = (id, value) => { $(id).innerHTML = value; };

const isWeighted = () => state.a.weighted;
const nameOf = (code) => NAMES[code] || code;
const regName = (code) => (meta.crimeReg[code] ? meta.crimeReg[code].name_en : code);

function select(code) {
  state.selected = state.selected === code ? null : code;
  redraw();
}

const highlight = (code, base = PALETTE[3]) => (code === state.selected ? ACCENT : base);

function fmt(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  if (digits === undefined) digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 3;
  return Number(value).toLocaleString('en-GB',
    { minimumFractionDigits: digits, maximumFractionDigits: digits });
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

const hideBanner = () => { const b = $('banner'); if (b) b.hidden = true; };

// 3. Data

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} (${response.status})`);
  return response.json();
}

async function loadTable(name) {
  const { columns, rows } = await loadJson(`data/${name}.json`);
  return rows.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function normalise() {
  data.crime_level.forEach(r => {
    if (r.offences === undefined) r.offences = r.numerator;
    if (r.crime_code === 'TOTAL') r.crime_code = AGG;
    if (r.denominator === 'area') { r.rate_per_1000 = null; r.rate_per_100000 = null; }
  });
  data.demographic_profile.forEach(r => {
    if (r.is_age_total === undefined) r.is_age_total = (r.age === 'ALL');
    if (!r.is_age_total) r.rate_per_10000 = null;
  });
}

const denomOf = (code, year, kind) => (kind === 'area' ? AREA[code] : POP[`${code}|${year}`]);
const levelRows = (year, crime, denominator) => data.crime_level.filter(r => r.year === year && r.crime_code === crime && r.denominator === denominator);
const byCode = (rows, value) => Object.fromEntries(rows.map(r => [r.ine_code, value(r)]));
const desc = (rows, value) => rows.slice().sort((a, b) => value(b) - value(a));


// 4. Map

let map = null;
let geoLayer = null;

function initMap() {
  map = L.map('map', {
    scrollWheelZoom: false, zoomSnap: 0.25, attributionControl: true,
    preferCanvas: true
  });
  map.attributionControl.addAttribution(
    'Boundaries: CC BY 4.0 <a href="https://idem.comunidad.madrid/">IDEM Comunidad de Madrid</a>');
}

function quantileBreaks(values) {
  const clean = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v))
                      .sort((a, b) => a - b);
  if (!clean.length) return [];
  return Array.from({ length: CLASSES - 1 }, (_, i) =>
    clean[Math.min(Math.floor(clean.length * (i + 1) / CLASSES), clean.length - 1)]);
}

function colourOf(value, cuts) {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_DATA;
  if (!cuts.length) return PALETTE[PALETTE.length - 1];
  let i = 0;
  while (i < cuts.length && value > cuts[i]) i++;
  return PALETTE[i];
}

function drawChoropleth(values, unit, title, extra = {}) {
  if (!boundaries || !map) return;

  const categorical = Boolean(extra.colour);
  const cuts = categorical ? [] : quantileBreaks(Object.values(values));
  if (geoLayer) map.removeLayer(geoLayer);

  geoLayer = L.geoJSON(boundaries, {
    style: ({ properties }) => {
      const value = values[properties.ine_code];
      const hasData = value !== null && value !== undefined;
      const chosen = properties.ine_code === state.selected;
      return {
        fillColor: categorical ? (extra.colour[properties.ine_code] || NO_DATA) : colourOf(value, cuts),
        fillOpacity: hasData ? 0.92 : 0.5,
        color: chosen ? ACCENT : (hasData ? '#8d99a6' : '#b9c1c9'),
        weight: chosen ? 3 : 0.6,
        dashArray: hasData ? null : '3 3'
      };
    },
    onEachFeature: ({ properties }, layer) => {
      const value = values[properties.ine_code];
      const shown = (value === null || value === undefined)
        ? '<em>not published by the Ministry of the Interior</em>'
        : `<strong>${fmt(value)}</strong> ${unit}`;
      const more = extra.line && extra.line[properties.ine_code]
        ? `<br>${extra.line[properties.ine_code]}` : '';
      layer.bindTooltip(`<strong>${nameOf(properties.ine_code)}</strong><br>${shown}${more}`, { className: 'mun-tooltip', sticky: true });
      layer.on('click', () => select(properties.ine_code));
    }
  }).addTo(map);

  if (!map._fitted) { map.fitBounds(geoLayer.getBounds(), { padding: [8, 8] }); map._fitted = true; }

  if (categorical) drawKeyLegend(extra.key, title);
  else drawLegend(cuts, unit, title);
}

function drawLegend(cuts, unit, title) {
  const swatch = (colour, label) => `<span class="swatch"><i style="background:${colour}"></i>${label}</span>`;

  const classes = cuts.length ? CLASSES : 1;
  const ranges = Array.from({ length: classes }, (_, i) => {
    const lower = i === 0 ? null : cuts[i - 1];
    const upper = i === classes - 1 ? null : cuts[i];
    const label = lower === null && upper === null ? 'all values'
                : lower === null ? `up to ${fmt(upper)}`
                : upper === null ? `more than ${fmt(lower)}`
                : `${fmt(lower)} to ${fmt(upper)}`;
    return swatch(PALETTE[cuts.length ? i : PALETTE.length - 1], label);
  });
  ranges.push(swatch(NO_DATA, 'not published'));
  setHtml('legend', `<div class="legend-title">${title}${unit ? `, ${unit}` : ''}</div>` + `<div class="legend-row">${ranges.join('')}</div>`);
}

function drawKeyLegend(items, title) {
  const swatch = (colour, label) => `<span class="swatch"><i style="background:${colour}"></i>${label}</span>`;

  const entries = items.map(i => swatch(i.colour, i.label));
  entries.push(swatch(NO_DATA, 'not published'));

  setHtml('legend', `<div class="legend-title">${title}</div>` + `<div class="legend-row">${entries.join('')}</div>`);
}


// 5. Charts

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } }, title: { display: false } }
};

function chartOptions(extra) {
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

const sizeBox = (boxId, height) => { $(boxId).style.height = `${height}px`; };

function rankedBar(canvasId, boxId, items, { label, unit, series, onPick, tip, perBar = 24 }) {
  sizeBox(boxId, Math.max(260, items.length * perBar + 90));

  render(canvasId, {
    type: 'bar',
    data: {
      labels: items.map(label),
      datasets: series.map(s => ({
        label: s.name || unit,
        data: items.map(s.value),
        backgroundColor: typeof s.colour === 'function' ? items.map(s.colour) : s.colour,
        borderWidth: 0
      }))
    },
    options: chartOptions({
      indexAxis: 'y',
      onClick: onPick && ((event, picked) => { if (picked.length) onPick(items[picked[0].index]); }),
      plugins: {
        legend: { display: series.length > 1, position: 'top' },
        tooltip: tip ? { callbacks: { label: (ctx) => tip(items[ctx.dataIndex]) } } : {}
      },
      scales: {
        x: { beginAtZero: true, title: { display: true, text: unit } },
        y: { ticks: { autoSkip: false, font: { size: 11 } } }
      }
    })
  });
}

function overYears(canvasId, type, years, datasets, yTitle) {
  render(canvasId, {
    type,
    data: { labels: years, datasets },
    options: chartOptions({
      plugins: { legend: { display: datasets.length > 1 } },
      scales: { y: { beginAtZero: true, title: { display: true, text: yTitle } } }
    })
  });
}

function municipalityViews(rows, value, unit, title) {
  drawChoropleth(byCode(rows, value), unit, title);

  setText('wide-title', `Every municipality with published data, ${state.year}`);
  rankedBar('chart-wide', 'wide-box', desc(rows.filter(r => value(r) !== null && value(r) !== undefined), value), {
    label: r => nameOf(r.ine_code),
    unit,
    series: [{ value, colour: r => highlight(r.ine_code) }],
    onPick: r => select(r.ine_code)
  });
}


// 6. Table

const FORMATS = {
  text: (v) => (v === null || v === undefined ? '' : String(v)),
  int:  (v) => fmt(v, 0),
  dec2: (v) => fmt(v, 2),
  dec3: (v) => fmt(v, 3),
  pct1: (v) => (v === null || v === undefined ? '' : `${fmt(v * 100, 1)} %`)
};

const col = (key, label, format = 'text') => ({ key, label, format });

function setTable(columns, rows, config) {
  table = Object.assign({ columns, rows, sortDir: 'desc', rowKey: null, note: '' }, config, { sortKey: config.sortKey || columns[0].key });
  setText('table-title', config.title || 'All the numbers');
  setHtml('table-note', table.note);
  drawTable();
}

function drawTable() {
  if (!table) return;
  const { columns, sortKey, sortDir, rowKey } = table;

  const sorted = table.rows.slice().sort((a, b) => {
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

  const body = sorted.map(row => {
    const key = rowKey ? row[rowKey] : null;
    const cells = columns.map(c => `<td class="${c.format === 'text' ? '' : 'num'}">${FORMATS[c.format](row[c.key])}</td>`).join('');
    return `<tr${key && key === state.selected ? ' class="selected"' : ''} ` + `data-key="${key || ''}">${cells}</tr>`;
  }).join('');

  const element = $('data-table');
  element.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;

  element.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    if (table.sortKey === th.dataset.key) table.sortDir = table.sortDir === 'asc' ? 'desc' : 'asc';
    else { table.sortKey = th.dataset.key; table.sortDir = 'desc'; }
    drawTable();
  }));

  if (rowKey) {
    element.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
      if (tr.dataset.key) select(tr.dataset.key);
    }));
  }
}

function downloadCsv() {
  if (!table) return;
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [table.columns.map(c => escape(c.label)).join(',')]
    .concat(table.rows.map(row => table.columns.map(c => escape(row[c.key])).join(',')));

  const url = URL.createObjectURL(
    new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: table.filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}


// 7. Module A. Crime level

function compositeRows(year, indicatorKey, weights) {
  const spec = A_INDICATORS[indicatorKey];
  const totals = {};

  data.crime_level.forEach(r => {
    if (r.year !== year || r.denominator !== spec.denominator || r.crime_code === AGG) return;
    const entry = totals[r.ine_code] || (totals[r.ine_code] = { ine_code: r.ine_code, points: 0, offences: 0 });
    entry.points += (weights[r.crime_code] || 0) * r.offences;
    entry.offences += r.offences;
  });

  const rows = Object.values(totals);
  rows.forEach(e => {
    e.name = nameOf(e.ine_code);
    e.denom = denomOf(e.ine_code, year, spec.denominator);
    const per = (n) => (spec.scale === null ? n : (e.denom ? n / e.denom * spec.scale : null));
    e.score = per(e.points);
    e.plain = per(e.offences);
  });

  rows.slice().sort((a, b) => b.score - a.score).forEach((e, i) => { e.rank = i + 1; });
  rows.slice().sort((a, b) => b.plain - a.plain).forEach((e, i) => { e.rankPlain = i + 1; });
  rows.forEach(e => { e.rankChange = e.rankPlain - e.rank; });

  return rows;
}

const drawA = () => (isWeighted() ? drawAWeighted() : drawASingle());

function drawASingle() {
  const spec = A_INDICATORS[state.a.indicator];
  const crimeName = state.a.crime === AGG
    ? 'All offence types' : (meta.crimeMun[state.a.crime] || state.a.crime);
  const rows = levelRows(state.year, state.a.crime, spec.denominator);

  setText('left-title', `${crimeName}, ${state.year}`);
  municipalityViews(rows, r => r[spec.field], spec.unit, crimeName);
  setText('wide-note', 'Sorted from highest to lowest. Click a bar to select that municipality on the map and in the table.');

  const series = state.selected
    ? data.crime_level
        .filter(r => r.ine_code === state.selected && r.crime_code === state.a.crime && r.denominator === spec.denominator)
        .sort((a, b) => a.year - b.year)
    : [];

  if (series.length) {
    showRight('chart');
    sizeBox('right-chart-box', 340);
    setText('right-title', `${nameOf(state.selected)} over time`);
    overYears('chart-right', 'line', series.map(r => r.year), [{
      label: spec.unit, data: series.map(r => r[spec.field]),
      borderColor: ACCENT, backgroundColor: ACCENT, tension: 0.25, pointRadius: 4
    }], spec.unit);
  } else {
    showRight('empty');
    setText('right-title', 'One municipality over time');
    setHtml('right-empty',
      'Select a municipality to see how this indicator moved between 2019 and 2025.' +
      '<span>Click it on the map, on a bar of the ranking below, or on a row of the table.</span>');
  }

  const perMunicipality = {};
  data.crime_level
    .filter(r => r.year === state.year && r.crime_code === state.a.crime)
    .forEach(r => {
      const e = perMunicipality[r.ine_code] || (perMunicipality[r.ine_code] = {
        name: nameOf(r.ine_code), ine_code: r.ine_code,
        population: denomOf(r.ine_code, state.year, 'population'), area: AREA[r.ine_code]
      });
      e.offences = r.offences;
      if (r.denominator === 'population') e.per1000 = r.rate_per_1000;
      if (r.denominator === 'area') e.perKm2 = r.rate;
    });

  setTable([
    col('name', 'Municipality'), col('ine_code', 'INE code'),
    col('population', 'Inhabitants', 'int'), col('area', 'Area, km²', 'dec2'),
    col('offences', 'Recorded offences', 'int'),
    col('per1000', 'Per 1,000 inhabitants', 'dec2'), col('perKm2', 'Per km²', 'dec2')
  ], Object.values(perMunicipality), {
    title: `${crimeName}, ${state.year}, all the numbers`,
    sortKey: { per1000: 'per1000', perkm2: 'perKm2', count: 'offences' }[state.a.indicator],
    rowKey: 'ine_code',
    filename: `crime_level_${state.a.crime}_${state.year}.csv`,
    note: 'One row per municipality with published data. Click a row to select it on the map. Click a column heading to sort by it.'
  });
}

function drawAWeighted() {
  const spec = A_INDICATORS[state.a.indicator];
  const rows = compositeRows(state.year, state.a.indicator, state.a.weights);

  setText('left-title', `Weighted index, ${state.year}`);
  drawChoropleth(byCode(rows, r => r.score), spec.weightedUnit, 'Weighted index');

  showRight('weights');
  setText('right-title', 'Choose how much each offence type counts');

  const movers = desc(rows, r => Math.abs(r.rankChange))
    .filter(r => r.rankChange !== 0).slice(0, 3);
  setHtml('right-note', movers.length
    ? 'Largest movements caused by your weights: ' + movers.map(r =>
        `<strong>${r.name}</strong> ${r.rankChange > 0 ? 'up' : 'down'} ${Math.abs(r.rankChange)}`
      ).join(', ') + '.'
    : 'Your weights do not change the ranking at all.');

  setText('wide-title', `Ranking under your weights, ${state.year}`);
  rankedBar('chart-wide', 'wide-box', desc(rows, r => r.score), {
    label: r => r.name,
    unit: spec.weightedUnit,
    series: [
      { name: 'with your weights', value: r => r.score,
        colour: r => highlight(r.ine_code, PALETTE[4]) },
      { name: 'every offence counts one', value: r => r.plain, colour: PALETTE[2] }
    ],
    onPick: r => select(r.ine_code)
  });

  const isPopulation = spec.denominator === 'population';
  setTable([
    col('name', 'Municipality'), col('ine_code', 'INE code'),
    col('denom', isPopulation ? 'Inhabitants' : 'Area, km²', isPopulation ? 'int' : 'dec2'),
    col('offences', 'Recorded offences', 'int'), col('points', 'Weighted points', 'dec2'),
    col('score', 'Weighted index', 'dec2'), col('plain', 'Unweighted', 'dec2'),
    col('rank', 'Rank, weighted', 'int'), col('rankPlain', 'Rank, unweighted', 'int'),
    col('rankChange', 'Places gained', 'int')
  ], rows, {
    title: `Weighted index, ${state.year}, all the numbers`,
    sortKey: 'score', rowKey: 'ine_code',
    filename: `crime_level_weighted_${state.year}.csv`,
    note: 'Weighted points is the sum over offence types of your weight times the number of ' +
          'offences. The index divides it by population or area. Places gained is positive when ' +
          'your weights move a municipality up the ranking.'
  });
}


// 8. Module B. Police performance

function drawB() {
  const indicator = B_INDICATORS[state.b.indicator];
  const series = data.police_performance
    .filter(r => r.crime_code === state.b.crime)
    .sort((a, b) => a.year - b.year);
  const years = series.map(r => r.year);

  setText('left-title', `${regName(state.b.crime)}, ${indicator.label.toLowerCase()} by year`);
  sizeBox('left-chart-box', 340);

  if (state.b.indicator === 'clearance_rate') {
    overYears('chart-left', 'line', years, [{
      label: 'Clearance rate, %',
      data: series.map(r => r.clearance_rate === null ? null : r.clearance_rate * 100),
      borderColor: ACCENT, backgroundColor: ACCENT, tension: 0.25,
      pointRadius: series.map(r => r.clearance_above_one ? 8 : 4),
      pointStyle: series.map(r => r.clearance_above_one ? 'triangle' : 'circle')
    }], 'per cent of recorded offences cleared');
  } else {
    const bars = [{ label: indicator.label, data: series.map(r => r[state.b.indicator]), backgroundColor: PALETTE[4], borderWidth: 0 }];
    if (state.b.indicator !== 'recorded') {
      bars.push({ label: 'Recorded, for reference', data: series.map(r => r.recorded), backgroundColor: PALETTE[2], borderWidth: 0 });
    }
    overYears('chart-left', 'bar', years, bars, 'offences');
  }

  const unsolved = desc(data.police_performance.filter(r => r.year === state.year && r.level === state.b.level && r.unsolved > 0), r => r.unsolved);
  const top = unsolved.slice(0, 7);
  const rest = unsolved.slice(7).reduce((sum, r) => sum + r.unsolved, 0);

  showRight('chart');
  sizeBox('right-chart-box', 340);
  setText('right-title', `What is unsolved in ${state.year}`);
  render('chart-right', {
    type: 'doughnut',
    data: {
      labels: top.map(r => regName(r.crime_code)).concat(rest > 0 ? ['All other categories'] : []),
      datasets: [{
        data: top.map(r => r.unsolved).concat(rest > 0 ? [rest] : []),
        backgroundColor: [PALETTE[4], PALETTE[3], PALETTE[2], PALETTE[1], ACCENT, PINK, '#7f8fa0', NO_DATA],
        borderWidth: 1, borderColor: '#fff'
      }]
    },
    options: chartOptions({
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => {
          const total = ctx.dataset.data.reduce((sum, v) => sum + v, 0);
          return `${ctx.label}: ${fmt(ctx.parsed, 0)} offences, ${fmt(ctx.parsed / total * 100, 1)} %`;
        } } }
      }
    })
  });

  const byCategory = data.police_performance
    .filter(r => r.year === state.year && r.level === state.b.level && r.recorded > 0)
    .map(r => ({
      code: r.crime_code,
      name: regName(r.crime_code),
      value: indicator.percent ? (r.clearance_rate || 0) * 100 : r[state.b.indicator]
    }));

  setText('wide-title', `${indicator.label} by category, level ${state.b.level}, ${state.year}`);
  rankedBar('chart-wide', 'wide-box', desc(byCategory, r => r.value), {
    label: r => r.name, unit: indicator.unit, perBar: 26,
    series: [{ value: r => r.value, colour: PALETTE[3] }],
    onPick: r => { state.b.crime = r.code; $('b-crime').value = r.code; redraw(); }
  });

  setTable([
    col('name', 'Offence category'), col('code', 'Code'), col('level', 'Level', 'int'),
    col('recorded', 'Recorded', 'int'), col('cleared', 'Cleared', 'int'),
    col('unsolved', 'Unsolved', 'int'), col('clearance', 'Clearance rate', 'pct1'),
    col('shareInLevel', 'Share of unsolved in its level', 'pct1')
  ], data.police_performance.filter(r => r.year === state.year).map(r => ({
    name: regName(r.crime_code), code: r.crime_code, level: r.level,
    recorded: r.recorded, cleared: r.cleared, unsolved: r.unsolved,
    clearance: r.clearance_rate, shareInLevel: r.unsolved_share_in_level
  })), {
    title: `Police performance, ${state.year}, all 44 categories`,
    sortKey: 'recorded',
    filename: `police_performance_${state.year}.csv`,
    note: 'Rows of different levels overlap, so do not add them together.'
  });
}


// 9. Module C. Victims and offenders

const demographicRows = (measure) => data.demographic_profile.filter(r => r.measure === measure && r.year === state.year && r.crime_code === state.c.crime);

function drawC() {
  const name = regName(state.c.crime);
  const field = state.c.indicator;
  const unit = field === 'share' ? 'per cent of the total' : 'people';
  const scale = field === 'share' ? 100 : 1;
  const bands = demographicRows(state.c.measure).filter(r => !r.is_age_total);
  const ages = AGE_ORDER.filter(a => bands.some(r => r.age === a));
  const value = (age, sex) => {
    const row = bands.find(r => r.age === age && r.sex === sex);
    return row ? (row[field] || 0) * scale : 0;
  };

  setText('left-title',
    `${state.c.measure === 'victims' ? 'Victims' : 'Arrested or investigated persons'}, ` +
    `${name}, ${state.year}`);
  sizeBox('left-chart-box', 420);

  render('chart-left', {
    type: 'bar',
    data: {
      labels: ages.map(a => AGE_LABEL[a] || a),
      datasets: [
        { label: 'Male', data: ages.map(a => -value(a, 'M')), backgroundColor: PALETTE[4] },
        { label: 'Female', data: ages.map(a => value(a, 'F')), backgroundColor: PINK }
      ]
    },
    options: chartOptions({
      indexAxis: 'y',
      plugins: { tooltip: { callbacks: {
        label: (ctx) => `${ctx.dataset.label}: ${fmt(Math.abs(ctx.parsed.x))} ${unit}` } } },
      scales: {
        x: { stacked: true, title: { display: true, text: unit }, ticks: { callback: (v) => fmt(Math.abs(v)) } },
        y: { stacked: true, ticks: { autoSkip: false }, title: { display: true, text: 'age band' } }
      }
    })
  });

  const unknownSex = bands.filter(r => r.sex === 'U').reduce((sum, r) => sum + (r.cases || 0), 0);
  setText('left-note', unknownSex
    ? `Records of unknown sex are not drawn: ${fmt(unknownSex, 0)} in this selection.`
    : 'No record of unknown sex in this selection.');

  const total = (measure, age, sex) => demographicRows(measure)
    .filter(r => r.age === age && r.sex === sex)
    .reduce((sum, r) => sum + (r[field] || 0), 0) * scale;

  showRight('chart');
  sizeBox('right-chart-box', 420);
  setText('right-title', 'Victims compared with arrested or investigated persons');

  render('chart-right', {
    type: 'bar',
    data: {
      labels: COMPARABLE_BANDS,
      datasets: [
        ['Victims, male', 'victims', 'M', PALETTE[2]],
        ['Victims, female', 'victims', 'F', '#e0b6c4'],
        ['Arrested, male', 'offenders', 'M', PALETTE[4]],
        ['Arrested, female', 'offenders', 'F', PINK]
      ].map(([label, measure, sex, colour]) => ({
        label, backgroundColor: colour,
        data: COMPARABLE_BANDS.map(age => total(measure, age, sex))
      }))
    },
    options: chartOptions({
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { title: { display: true, text: 'age band' }, ticks: { autoSkip: false } },
        y: { beginAtZero: true, title: { display: true, text: unit } }
      }
    })
  });
  setText('right-note', 'Only the five age bands that both series cover. Victims are recorded from age zero and arrested or investigated persons from age fourteen.');

  setTable([
    col('measure', 'People counted'), col('age', 'Age band'), col('sex', 'Sex'),
    col('cases', 'People', 'int'), col('share', 'Share of the total', 'pct1'),
    col('rate', 'Per 10,000 inhabitants of that sex', 'dec2'),
    col('comparable', 'Comparable band')
  ], data.demographic_profile
      .filter(r => r.year === state.year && r.crime_code === state.c.crime)
      .map(r => ({
        measure: r.measure === 'victims' ? 'Victims' : 'Arrested or investigated',
        age: r.is_age_total ? 'All ages' : (AGE_LABEL[r.age] || r.age),
        sex: SEX_LABEL[r.sex] || r.sex,
        cases: r.cases, share: r.share, rate: r.rate_per_10000,
        comparable: r.comparable_band ? 'yes' : 'no'
      })), {
    title: `${name}, ${state.year}, all the numbers`,
    sortKey: 'cases',
    filename: `demographic_profile_${state.c.crime}_${state.year}.csv`,
    note: 'Both Victims and Arrested or investigated persons are listed. ' +
          'The rate per 10,000 is filled in only for the All ages rows, because ' +
          'the population behind it is available by sex and not by age band.'
  });
}


// 10. Module D. Crime structure

function offenceMix(year, ineCode) {
  const counts = {};
  data.crime_level.forEach(r => {
    if (r.year !== year || r.denominator !== 'population' || r.crime_code === AGG) return;
    if (ineCode && r.ine_code !== ineCode) return;
    counts[r.crime_code] = (counts[r.crime_code] || 0) + r.offences;
  });
  const total = Object.values(counts).reduce((sum, v) => sum + v, 0);

  return desc(meta.crime_types_mun.map(t => ({
    name: t.name_en, violence: t.violence,
    offences: counts[t.code] || 0,
    share: total ? (counts[t.code] || 0) / total : 0
  })), m => m.share);
}

function specialisation(year) {
  const best = {};
  data.crime_specialisation.forEach(r => {
    if (r.year !== year || r.location_quotient === null) return;
    if (r.offences < MIN_OFFENCES) return;
    const current = best[r.ine_code];
    if (!current || r.location_quotient > current.lq) {
      best[r.ine_code] = {
        ine_code: r.ine_code, code: r.crime_code,
        crime: meta.crimeMun[r.crime_code] || r.crime_code,
        lq: r.location_quotient, offences: r.offences, share: r.local_share
      };
    }
  });
  return Object.values(best);
}

function drawD() {
  if (state.d.indicator === 'specialisation') { drawSpecialisation(); return; }
  const indicator = D_INDICATORS[state.d.indicator];
  const rows = data.crime_structure.filter(r => r.year === state.year);

  setText('left-title', `${indicator.label}, ${state.year}`);
  municipalityViews(rows, r => r[state.d.indicator], indicator.unit, indicator.label);
  setText('left-note', indicator.plain);

  const mix = offenceMix(state.year, state.selected);
  showRight('chart');
  setText('right-title', state.selected
    ? `What the offences are, ${nameOf(state.selected)}, ${state.year}`
    : `What the offences are, all published municipalities, ${state.year}`);

  rankedBar('chart-right', 'right-chart-box', mix, {
    label: m => m.name, unit: 'per cent of recorded offences', perBar: 26,
    series: [{ value: m => m.share * 100, colour: m => VIOLENCE_COLOUR[m.violence] || GREY }],
    tip: m => `${fmt(m.share * 100, 1)} % of offences, ${fmt(m.offences, 0)} recorded`
  });

  const chosen = state.selected ? rows.find(r => r.ine_code === state.selected) : null;
  setHtml('right-note',
    `<span class="key"><i style="background:${ACCENT}"></i>violent` +
    `<i style="background:${PALETTE[4]}"></i>non violent` +
    `<i style="background:${GREY}"></i>cannot be classified</span><br>` +
    (chosen
      ? `<strong>This chart is showing ${nameOf(state.selected)} alone</strong>, because it is ` +
        'selected on the map. Use Clear selection above the map, to go back ' +
        `to all municipalities together. Here the grey bar is ` +
        `${fmt(chosen.unclassified_share * 100, 1)} per cent of all offences and the violent ` +
        'share is computed over the rest. The more even the bars, the higher the variety.'
      : '<strong>Click a municipality on the map, on the ranking below or in the table, and this ' +
        'chart shows that municipality alone.</strong>'));

  setTable([
    col('name', 'Municipality'), col('ine_code', 'INE code'),
    col('population', 'Inhabitants', 'int'), col('total', 'Offences', 'int'),
    col('violent', 'Violent', 'int'), col('non_violent', 'Non violent', 'int'),
    col('unclassified', 'Cannot be classified', 'int'),
    col('violent_share', 'Violent share', 'pct1'),
    col('violent_ratio', 'Violent per non violent', 'dec3'),
    col('unclassified_share', 'Share not classified', 'pct1'),
    col('shannon', 'Shannon entropy', 'dec3'),
    col('shannon_normalised', 'Variety, 0 to 1', 'dec3')
  ], rows.map(r => Object.assign({ name: nameOf(r.ine_code) }, r)), {
    title: `Crime structure, ${state.year}, all the numbers`,
    sortKey: 'total', rowKey: 'ine_code',
    filename: `crime_structure_${state.year}.csv`,
    note: 'Violent, non violent and cannot be classified add up to the offence count. The violent ' +
          'share is computed over the first two only.'
  });
}

function drawSpecialisation() {
  const rows = specialisation(state.year);
  const tally = desc(Object.values(rows.reduce((acc, r) => {
    (acc[r.code] || (acc[r.code] = { code: r.code, crime: r.crime, n: 0 })).n += 1;
    return acc;
  }, {})), t => t.n);
  const crimeColour = (code) => CRIME_COLOUR[code] || GREY;
  const keyItems = tally.map(t => ({ label: t.crime, colour: crimeColour(t.code) }));
  const key = tally.map(t => `<i style="background:${crimeColour(t.code)}"></i>${t.crime}`).join('');

  setText('left-title', `Offence each municipality stands out in, ${state.year}`);
  drawChoropleth(byCode(rows, r => r.lq), 'location quotient', `Offence each municipality stands out in, ${state.year}`, {
    colour: byCode(rows, r => crimeColour(r.code)),
    line: byCode(rows, r => `stands out in <strong>${r.crime.toLowerCase()}</strong>`),
    key: keyItems
  });
  setText('left-note', D_INDICATORS.specialisation.plain);

  setText('wide-title', `Every municipality with published data, ${state.year}`);
  rankedBar('chart-wide', 'wide-box', desc(rows, r => r.lq), {
    label: r => nameOf(r.ine_code),
    unit: 'location quotient',
    series: [{ value: r => r.lq, colour: r => crimeColour(r.code) }],
    onPick: r => select(r.ine_code),
    tip: r => `${r.crime}: ${fmt(r.share * 100, 1)} % of the local mix, ` +
              `${fmt(r.lq, 2)} times the reference share`
  });
  setHtml('wide-note', 'Each bar is coloured by the offence type that municipality stands out in. Click a bar to load that municipality into the chart beside the map.');

  showRight('chart');
  setText('right-title', `Offence types municipalities stand out in, ${state.year}`);
  rankedBar('chart-right', 'right-chart-box', tally, {
    label: t => t.crime, unit: 'municipalities', perBar: 26,
    series: [{ value: t => t.n, colour: t => crimeColour(t.code) }],
    tip: t => `${t.n} municipalities stand out in ${t.crime.toLowerCase()}`
  });
  setHtml('right-note',
    `Only offence types with at least ${MIN_OFFENCES} recorded offences in the municipality ` +
    'are eligible, so a single incident cannot make a municipality stand out.');

  setTable([
    col('name', 'Municipality'), col('ine_code', 'INE code'),
    col('crime', 'Stands out in'),
    col('lq', 'Location quotient', 'dec2'),
    col('share', 'Share of the local mix', 'pct1'),
    col('offences', 'Recorded offences', 'int')
  ], rows.map(r => Object.assign({ name: nameOf(r.ine_code) }, r)), {
    title: `Specialisation, ${state.year}, all the numbers`,
    sortKey: 'lq', rowKey: 'ine_code',
    filename: `specialisation_${state.year}.csv`,
    note: 'The location quotient is the share the offence type takes of the local offence mix ' +
          'divided by the share it takes across every published municipality that year.'
  });
}


// 11. Methodology

function drawMethodology() {
  const published = {};
  data.crime_level
    .filter(r => r.denominator === 'population' && r.crime_code === AGG)
    .forEach(r => { (published[r.year] || (published[r.year] = new Set())).add(r.ine_code); });

  const total = meta.municipalities.length;
  setHtml('coverage-table',
    '<table class="plain"><thead><tr><th>Year</th>' +
    '<th>Municipalities with published crime data</th><th>Without</th><th>Coverage</th>' +
    '</tr></thead><tbody>' +
    meta.yearsOf('A').map(year => {
      const n = published[year] ? published[year].size : 0;
      return `<tr><td>${year}</td><td>${n}</td><td>${total - n}</td>` +
             `<td>${fmt(n / total * 100, 1)} %</td></tr>`;
    }).join('') + '</tbody></table>');

  setHtml('modules-table', ['A', 'B', 'C', 'D'].map(key => {
    const module = meta.modules[key];
    const hasMap = module.geography === 'municipality';
    return `<tr><td>${key}. ${module.name}</td>` +
           `<td>${hasMap ? 'Municipality' : 'Whole region'}</td>` +
           `<td>${module.years[0]} to ${module.years[1]}</td>` +
           `<td>${hasMap ? 'yes' : 'no, one figure for the region'}</td></tr>`;
  }).join(''));
}


// 12. One intro per module

const MODULES = {
  A: {
    hasMap: true, draw: drawA,
    note: () => {
      const spec = A_INDICATORS[state.a.indicator];
      const what = isWeighted() ? 'your weighted index of all offence types'
        : state.a.crime === AGG ? 'all offence types added together'
        : (meta.crimeMun[state.a.crime] || state.a.crime).toLowerCase();
      return `You are looking at <strong>${spec.label}</strong> for ${what}. ${spec.note}`;
    },
    title: 'Module A. Crime level: how much crime is there?',
    lead: 'This module measures the number of offences recorded in each municipality, taking its size into account.',
    points: [
      '<strong>Per 1,000 inhabitants</strong> measures offences in relation to the number of residents.',
      '<strong>Per square kilometre</strong> measures how concentrated offences are across the municipality.',
      '<strong>Number of offences</strong> shows the total number of recorded offences, without adjusting for municipality size.',
      'The <strong>weighted index</strong> button allows different weights to be assigned to each type of offence.'
    ],
    formula: `
      <div class="formula">
        Crime Level = Recorded Offences / Population × 1,000
        <span class="where">
          Used when measuring offences per 1,000 inhabitants.
        </span>
      </div>

      <div class="formula">
        Crime Level = Recorded Offences / Surface Area
        <span class="where">
          Used when measuring offences per square kilometre.
        </span>
      </div>

      <p>The weighted version:</p>

      <div class="formula">
        Weighted Crime Level = Σ (Weight × Recorded Offences) / Denominator × Scale
        <span class="where">
          The weight determines how much each type of offence contributes to the indicator.<br>
          With all weights equal to 1, this is the same as the unweighted indicator.
        </span>
      </div>
    `
  },
  B: {
    hasMap: false, draw: drawB,
    note: () => `You are looking at <strong>${B_INDICATORS[state.b.indicator].label.toLowerCase()}</strong> for ` +
                 `${regName(state.b.crime).toLowerCase()}, across the whole Community of Madrid.`,
    title: 'Module B. Police performance: how many offences are cleared?',
    lead: 'This module compares the number of offences recorded with the number of offences cleared by the police.',
    points: [
      '<strong>Clearance rate</strong> shows the percentage of recorded offences that were cleared. A higher value means that a larger share of offences was cleared.',
      '<strong>Unsolved offences</strong> shows the offences that were not cleared.',
      'A clearance rate above 100% is possible because offences cleared in a year may have been recorded in previous years.'
    ],
    formula: `
      <div class="formula">
        Clearance Rate = Cleared / Recorded
        <span class="where">
          Recorded = offences recorded in category c and year t<br>
          Cleared = offences cleared in category c and year t
        </span>
      </div>

      <div class="formula">
        Unsolved Offences = max(Recorded − Cleared, 0)
        <span class="where">
          Number of recorded offences that were not cleared
        </span>
      </div>

      <div class="formula">
        Unsolved Share = Unsolved / Total Unsolved
        <span class="where">
          Share of all unsolved offences accounted for by category c
        </span>
      </div>
    `
  },
  C: {
    hasMap: false, draw: drawC, stacked: true,
    note: () => `You are looking at the age and sex of <strong>` +
                 `${state.c.measure === 'victims' ? 'victims' : 'arrested or investigated persons'}</strong> ` +
                 `for ${regName(state.c.crime).toLowerCase()}, for the whole Community of Madrid.`,
    title: 'Module C. Victims and offenders: who is involved?',
    lead: 'This module shows the age and sex of recorded victims and of people arrested or under investigation.',
    points: [
      '<strong>Number of people</strong> shows the total number of recorded cases. <strong>Percentage of the total</strong> makes different years and categories easier to compare.',
      'Victims include all ages. Arrested and investigated people are counted from <strong>14 years old</strong>, so only the age groups from 14 onwards can be compared.',
      'The same person can be recorded more than once, and one offence can have several victims. These are therefore <strong>records, not unique people.</strong>',
      'Some victim records have <strong>unknown sex</strong>. These are shown separately below the chart.'
    ],
    formula: `
      <div class="formula">
        Percentage = Cases / Total × 100
        <span class="where">
          Share of the total for each year and category.
        </span>
      </div>

      <div class="formula">
        Rate per 10,000 inhabitants = Cases / Population × 10,000
        <span class="where">
          Number of cases per 10,000 inhabitants of the same sex.
          This rate is shown only for the total across all age groups.
        </span>
      </div>
    `
  },
  D: {
    hasMap: true, draw: drawD,
    note: () => `You are looking at <strong>${D_INDICATORS[state.d.indicator].label.toLowerCase()}</strong>. ` +
                 D_INDICATORS[state.d.indicator].plain,
    title: 'Module D. Crime structure: what types of crime are there?',
    lead: 'This module shows how offences are distributed across different types, rather than how much crime there is.',
    points: [
      '<strong>Violent share</strong> shows the proportion of offences classified as violent.',
      '<strong>Variety of offences</strong> measures how evenly offences are distributed across different types. Low values mean that a few types dominate, while high values mean that offences are more evenly distributed. The normalised version ranges from <strong>0 to 1</strong>.',
      '<strong>Unclassified share</strong> shows the proportion of offences that cannot be classified as either violent or non-violent. The violent share is calculated only from the offences that can be classified.',
      `<strong>Offence the municipality stands out in</strong> is the offence that has a higher share in the municipality than in other municipalities.`
    ],
    formula: `
      <div class="formula">
        Violent Share = Violent / (Violent + Non-violent)
        <span class="where">
          Proportion of offences classified as violent, excluding offences that cannot be classified.
        </span>
      </div>

      <div class="formula">
        Unclassified Share = Unclassified / Total
        <span class="where">
          Proportion of all offences that cannot be classified as violent or non-violent.
        </span>
      </div>

      <div class="formula">
        Shannon Entropy = −Σ (Share of type × ln(Share of type))
        <span class="where">
          Measures how evenly offences are distributed across the types present.
        </span>
      </div>

      <div class="formula">
        Normalised Shannon Entropy = Shannon Entropy / Maximum Entropy
        <span class="where">
          The same measure scaled from 0 to 1, making it easier to compare municipalities.
        </span>
      </div>

      <div class="formula">
        Location Quotient = (c<sub>i,k</sub> / c<sub>i</sub>) &divide; (c<sub>k</sub> / c)
        <span class="where">
          c<sub>i,k</sub> = offences of type k in municipality i;<br>
          c<sub>i</sub> = all offences in municipality i;<br>
          c<sub>k</sub> = offences of type k across all published municipalities;<br>
          c = all offences across all published municipalities.<br>
          Compares the share of an offence type in a municipality with its share across all municipalities.
        </span>
      </div>
    `
  },
  M: {
    hasMap: false, draw: drawMethodology, methodology: true,
    title: 'Methodology, coverage and sources',
    lead: 'How the indicators are built, which municipalities the source covers, and what each number does not say.',
    points: [],
    formula: '',
  },
};


// 13. Drawing the page

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

  const control = $('year');
  control.innerHTML = '';
  years.slice().reverse().forEach(y => control.add(new Option(y, y)));
  control.value = state.year;
}

function drawIntro() {
  const module = MODULES[state.module];
  const points = module.points || [];
  const note = module.note ? module.note() : '';

  setText('intro-title', module.title);
  setText('intro-lead', module.lead);
  setHtml('intro-points', points.map(p => `<li>${p}</li>`).join('') + (note ? `<li class="current">${note}</li>` : ''));
  $('intro-points').hidden = !points.length && !note;
  $('intro-formula').hidden = !module.formula;
  setHtml('intro-formula-body', module.formula || '');
}

function updateFooter() {
  if (!MODULES[state.module].hasMap) {
    setText('coverage-note', state.module === 'M' ? '' :
      'These figures cover the whole Community of Madrid. The source publishes no municipal ' +
      'breakdown for this module, which is why there is no map.');
    return;
  }
  const published = new Set(data.crime_level
    .filter(r => r.year === state.year && r.denominator === 'population')
    .map(r => r.ine_code));
  setText('coverage-note',
    `${published.size} of ${meta.municipalities.length} municipalities have crime data published ` +
    `for ${state.year}. The rest are shown as "not published", never as zero.`);
}

function redraw() {
  const module = MODULES[state.module];
  const showMap = module.hasMap && boundaries;

  const main = document.querySelector('main');
  main.classList.toggle('methodology', !!module.methodology);
  main.classList.toggle('stacked', !!module.stacked);
  $('methodology').hidden = !module.methodology;
  $('panel-wide').hidden = !!module.stacked;

  document.querySelectorAll('.module-controls').forEach(block => {
    block.hidden = block.dataset.module !== state.module;
  });
  document.querySelectorAll('#tabs button').forEach(button => {
    button.classList.toggle('active', button.dataset.module === state.module);
  });

  $('a-weighted').classList.toggle('on', isWeighted());
  $('a-weighted').setAttribute('aria-pressed', String(isWeighted()));
  $('a-crime').disabled = isWeighted();

  const clear = $('clear-selection');
  clear.hidden = !(module.hasMap && state.selected);
  if (!clear.hidden) clear.textContent = `Clear ${nameOf(state.selected)}`;

  $('map').hidden = !showMap;
  $('legend').hidden = !showMap;
  $('left-chart-box').hidden = module.hasMap;
  if (module.hasMap) clearChart('chart-left');
  clearChart('chart-wide');
  ['left-note', 'right-note', 'wide-note'].forEach(id => setText(id, ''));

  drawIntro();
  module.draw();

  if (showMap) setTimeout(() => map.invalidateSize(), 0);
  updateFooter();
}


// 14. Controls and start up

function buildWeightEditor() {
  setHtml('weight-inputs', meta.crime_types_mun.map(type =>
    '<div class="weight-row">' +
    `<span class="name"><span class="swatch-dot" style="background:` +
    `${VIOLENCE_COLOUR[type.violence] || GREY}"></span>${type.name_en}</span>` +
    `<input type="number" min="0" step="0.5" value="${state.a.weights[type.code] ?? 1}" ` +
    `data-code="${type.code}" aria-label="Weight for ${type.name_en}">` +
    '</div>').join(''));
}

function setWeights(preset) {
  meta.crime_types_mun.forEach(t => { state.a.weights[t.code] = PRESETS[preset](t); });
  buildWeightEditor();
}

function readWeights() {
  $('weight-inputs').querySelectorAll('input').forEach(input => {
    const value = parseFloat(input.value);
    state.a.weights[input.dataset.code] = Number.isFinite(value) && value >= 0 ? value : 0;
  });
}

function buildMenus() {
  const crimes = $('a-crime');
  crimes.innerHTML = '';
  crimes.add(new Option('All offence types', AGG));
  meta.crime_types_mun.forEach(t => crimes.add(new Option(t.name_en, t.code)));
  crimes.value = state.a.crime;

  const regional = meta.crime_types_reg.slice().sort(
    (a, b) => a.level - b.level || a.code.localeCompare(b.code, 'en', { numeric: true }));

  ['b-crime', 'c-crime'].forEach(id => {
    const control = $(id);
    control.innerHTML = '';
    [0, 1, 2, 3].forEach(level => {
      const group = regional.filter(t => t.level === level);
      if (!group.length) return;
      const optgroup = document.createElement('optgroup');
      optgroup.label = level === 0 ? 'Everything' : `Level ${level}`;
      group.forEach(t => optgroup.appendChild(
        new Option(level === 0 ? t.name_en : `${t.code}. ${t.name_en}`, t.code)));
      control.appendChild(optgroup);
    });
    control.value = 'TOTAL';
  });
}

const SELECTS = {
  year:          (v) => { state.year = Number(v); },
  'a-indicator': (v) => { state.a.indicator = v; },
  'a-crime':     (v) => { state.a.crime = v; },
  'b-indicator': (v) => { state.b.indicator = v; },
  'b-crime':     (v) => { state.b.crime = v; },
  'b-level':     (v) => { state.b.level = Number(v); },
  'c-indicator': (v) => { state.c.indicator = v; },
  'c-measure':   (v) => { state.c.measure = v; },
  'c-crime':     (v) => { state.c.crime = v; },
  'd-indicator': (v) => { state.d.indicator = v; }
};

function wireControls() {
  Object.entries(SELECTS).forEach(([id, apply]) => {
    $(id).addEventListener('change', (event) => { apply(event.target.value); redraw(); });
  });

  document.querySelectorAll('#tabs button').forEach(button => {
    button.addEventListener('click', () => {
      state.module = button.dataset.module;
      syncYearSelector();
      redraw();
    });
  });

  document.querySelectorAll('button.preset').forEach(button => {
    button.addEventListener('click', () => { setWeights(button.dataset.preset); redraw(); });
  });

  $('a-weighted').addEventListener('click', () => { state.a.weighted = !isWeighted(); redraw(); });
  $('clear-selection').addEventListener('click', () => select(state.selected));
  $('apply-weights').addEventListener('click', () => { readWeights(); redraw(); });
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
      return Array.from({ length: last - first + 1 }, (_, i) => first + i);
    };

    NAMES = Object.fromEntries(meta.municipalities.map(m => [m.ine_code, titleCase(m.name)]));
    AREA = Object.fromEntries(meta.municipalities.map(m => [m.ine_code, m.surface_km2]));

    const names = ['crime_level', 'police_performance', 'demographic_profile', 'crime_structure', , 'crime_specialisation'];
    const tables = await Promise.all(names.map(loadTable));
    names.forEach((name, i) => { data[name] = tables[i]; });
    normalise();

    POP = Object.fromEntries(data.crime_structure.map(r => [`${r.ine_code}|${r.year}`, r.population]));

    try {
      boundaries = await loadJson('data/madrid_municipalities.geojson');
      boundaries.features.forEach(({ properties }) => {
        if (properties && properties.ine_code && properties.name) {
          NAMES[properties.ine_code] = properties.name;
        }
      });
      initMap();
    } catch (error) {
      boundaries = null;
      console.warn('Boundary file not loaded:', error.message);
    }

    setWeights('severity');
    buildMenus();
    wireControls();
    syncYearSelector();
    redraw();
    hideBanner();

  } catch (error) {
    banner(`The page could not load its data: ${error.message}. `, true);
    console.error(error);
  }
}

start();
