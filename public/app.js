// Feeder front end: scan settings, live page grid, page viewer and card identification.
// The server pushes `pages`, `job`, `identify`, `notice` and `done` events over SSE; this file renders them.

const $ = (id) => document.getElementById(id);

const PATHS = {
  refresh: '<path d="M3 12a9 9 0 0 1 15.36-6.36L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.36 6.36L3 16"/><path d="M3 21v-5h5"/>',
  rotateLeft: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/>',
  rotateRight: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M3 12h18"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
};

const icon = (name, size = 16, stroke = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pageUrl = (page) => `/scans/pages/${page.file}?v=${page.rev}`;
const thumbUrl = (page) => `/scans/thumbs/${page.id}.jpg?v=${page.rev}`;

const state = {
  pages: [],
  job: null,
  devices: null, // null while the first search is running
  deviceError: '',
  selected: new Set(),
  anchor: null, // last clicked page, for shift-click ranges
  viewing: null, // id of the page open in the viewer
  identify: null, // the identification run in progress, if any
};

const form = $('scanForm');
const grid = $('grid');
const viewer = $('viewer');
const cards = new Map(); // page id -> card element
let pendingCard = null;

// ---------------------------------------------------------------------------
// Server calls

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  return res.headers.get('content-type')?.includes('application/json') ? res.json() : res;
}

function connect() {
  const events = new EventSource('/api/events');
  const on = (name, fn) => events.addEventListener(name, (e) => fn(JSON.parse(e.data)));

  on('pages', (pages) => {
    state.pages = pages;
    const live = new Set(pages.map((p) => p.id));
    for (const id of state.selected) if (!live.has(id)) state.selected.delete(id);
    renderPages();
  });
  on('job', (job) => {
    state.job = job;
    renderJob();
    renderPages();
  });
  on('identify', (run) => {
    state.identify = run;
    renderPages();
  });
  on('notice', ({ level, message }) => toast(level, message));
  on('done', ({ pages, cancelled }) => {
    if (pages) toast('ok', `${cancelled ? 'Stopped after' : 'Scanned'} ${plural(pages, 'page')}.`);
    else if (cancelled) toast('ok', 'Scan cancelled.');
  });
}

// ---------------------------------------------------------------------------
// Settings

const SETTINGS_KEY = 'feeder.settings';

function readSettings() {
  const f = form.elements;
  return {
    device: f.device.value, sides: f.sides.value, mode: f.mode.value, resolution: f.resolution.value,
    paper: f.paper.value, game: $('game').value, autoIdentify: $('autoIdentify').checked,
  };
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch {}
  const usesLetter = /-(US|CA|MX|PH|CO|CL|VE)$/i.test(navigator.language);
  const values = { sides: 'single', mode: 'color', resolution: '300', paper: usesLetter ? 'letter' : 'a4', ...saved };
  if ([...$('game').options].some((o) => o.value === values.game)) $('game').value = values.game;
  $('autoIdentify').checked = values.autoIdentify === true;
  for (const name of ['sides', 'mode', 'resolution', 'paper']) {
    const field = form.elements[name];
    if (field instanceof HTMLSelectElement && ![...field.options].some((o) => o.value === values[name])) continue;
    field.value = values[name];
  }
  return saved;
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings())); } catch {}
}

// ---------------------------------------------------------------------------
// Scanners

let savedDevice = '';
let devicePoll = null;

async function refreshDevices() {
  clearTimeout(devicePoll);
  const button = $('refreshDevices');
  button.classList.add('spinning');
  try {
    state.devices = (await api('GET', '/api/scanners')).devices;
    state.deviceError = '';
  } catch (err) {
    state.devices = [];
    state.deviceError = err.message;
  } finally {
    button.classList.remove('spinning');
  }
  renderDevices();
  // Keep looking until the scanner is plugged in.
  if (!state.devices.length) devicePoll = setTimeout(refreshDevices, document.hidden ? 15000 : 5000);
}

function renderDevices() {
  const select = form.elements.device;
  const devices = state.devices ?? [];
  const current = select.value || savedDevice;
  select.replaceChildren(...devices.map((d) => new Option(d.name, d.id)));
  if (!devices.length) select.append(new Option(state.devices ? 'No scanner found' : 'Searching…', ''));
  if (devices.some((d) => d.id === current)) select.value = current;
  select.disabled = !devices.length;

  const chosen = devices.find((d) => d.id === select.value);
  $('deviceHint').textContent = state.deviceError
    || (state.devices && !devices.length ? 'Connect the scanner with its USB cable and switch it on. Feeder keeps looking automatically.' : '')
    || (chosen?.transport ? `Connected via ${chosen.transport}` : '');

  const pill = $('devicePill');
  if (state.job) {
    pill.dataset.state = 'busy';
    $('devicePillText').textContent = `Scanning${chosen ? ` · ${chosen.name}` : '…'}`;
  } else if (!state.devices) {
    pill.dataset.state = 'searching';
    $('devicePillText').textContent = 'Looking for scanners…';
  } else if (chosen) {
    pill.dataset.state = 'ready';
    $('devicePillText').textContent = chosen.name;
  } else {
    pill.dataset.state = 'missing';
    $('devicePillText').textContent = 'No scanner connected';
  }
}

// ---------------------------------------------------------------------------
// Scanning

form.addEventListener('change', () => {
  saveSettings();
  renderPaperHint();
});
$('game').addEventListener('change', saveSettings);
$('autoIdentify').addEventListener('change', saveSettings);

function renderPaperHint() {
  $('paperHint').textContent = form.elements.paper.value === 'tcg'
    ? 'Scans a little larger than the card, so a card that feeds in crooked isn’t cut off.'
    : '';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.job) return;
  const s = readSettings();
  try {
    await api('POST', '/api/scan', {
      device: s.device,
      duplex: s.sides === 'duplex',
      mode: s.mode,
      resolution: Number(s.resolution),
      paper: s.paper,
      identify: s.autoIdentify,
      game: s.game,
    });
  } catch (err) {
    toast('error', err.message);
  }
});

$('cancelBtn').addEventListener('click', () => {
  api('POST', '/api/scan/cancel', {}).catch((err) => toast('error', err.message));
});

function renderJob() {
  const { job } = state;
  const button = $('scanBtn');
  const iconName = job ? 'spinner' : 'scan';
  if (button.dataset.icon !== iconName) {
    button.dataset.icon = iconName;
    button.querySelector('.scan-btn-icon').innerHTML = icon(iconName, 20, job ? 2.5 : 2);
  }
  button.disabled = Boolean(job);
  button.classList.toggle('busy', Boolean(job));
  $('scanBtnText').textContent = !job ? 'Scan' : job.pages ? `Scanning · ${plural(job.pages, 'page')}` : 'Scanning…';
  $('settings').disabled = Boolean(job);

  $('jobBox').hidden = !job;
  if (job) {
    const known = typeof job.percent === 'number' && job.percent > 0;
    $('jobStatus').textContent = job.status;
    $('jobProgress').classList.toggle('indeterminate', !known);
    $('jobProgress').firstElementChild.style.width = known ? `${job.percent}%` : '';
    $('cancelBtn').hidden = job.cancelled;
  }
  renderDevices();
}

// ---------------------------------------------------------------------------
// Page grid

function renderPages() {
  const wanted = state.pages.map((page, i) => updateCard(page, i));
  if (state.job) wanted.push(updatePendingCard());
  // Only move nodes that are out of place, so existing cards don't re-run their entry animation.
  wanted.forEach((el, i) => {
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] ?? null);
  });
  while (grid.children.length > wanted.length) grid.lastElementChild.remove();

  const live = new Set(state.pages.map((p) => p.id));
  for (const id of cards.keys()) if (!live.has(id)) cards.delete(id);

  $('empty').hidden = state.pages.length > 0 || Boolean(state.job);
  renderToolbar();
  renderSummary();
  if (state.viewing) renderViewer();
}

function updateCard(page, index) {
  let card = cards.get(page.id);
  if (!card) {
    card = document.createElement('figure');
    card.className = 'page';
    card.draggable = true;
    card.dataset.id = page.id;
    card.innerHTML = `
      <button type="button" class="page-thumb"><img alt="" draggable="false"></button>
      <label class="page-check"><input type="checkbox">${icon('check', 14, 3)}</label>
      <div class="page-tools">
        <button type="button" data-act="rotl" title="Rotate left" aria-label="Rotate left">${icon('rotateLeft')}</button>
        <button type="button" data-act="rotr" title="Rotate right" aria-label="Rotate right">${icon('rotateRight')}</button>
        <button type="button" class="danger" data-act="delete" title="Delete" aria-label="Delete">${icon('trash')}</button>
      </div>
      <figcaption></figcaption>
      <p class="page-match"></p>`;
    cards.set(page.id, card);
  }
  const img = card.querySelector('img');
  const src = thumbUrl(page);
  if (img.getAttribute('src') !== src) img.src = src;

  const selected = state.selected.has(page.id);
  const check = card.querySelector('input');
  check.checked = selected;
  check.setAttribute('aria-label', `Select page ${index + 1}`);
  card.querySelector('.page-thumb').setAttribute('aria-label', `Open page ${index + 1}`);
  card.querySelector('figcaption').textContent = index + 1;
  card.classList.toggle('selected', selected);
  card.classList.toggle('checking', state.identify?.current === page.id);

  const label = matchLabel(page);
  const line = card.querySelector('.page-match');
  line.textContent = label.text;
  line.title = label.detail;
  line.dataset.tone = label.tone;
  line.hidden = !label.text;
  return card;
}

/** One-line identification result for a page, for the grid. */
function matchLabel(page) {
  const run = state.identify;
  if (run?.current === page.id) return { text: 'Identifying…', tone: 'busy', detail: '' };
  if (run && !run.stopping && run.ids.indexOf(page.id) >= run.done) return { text: 'Queued', tone: 'none', detail: '' };
  const { match } = page;
  if (!match) return { text: '', tone: '', detail: '' };
  if (match.status === 'candidates') {
    const top = match.candidates[0];
    return { text: top.name, tone: 'found', detail: [top.name, top.set, top.number].filter(Boolean).join(' · ') };
  }
  const detail = match.reason ?? '';
  if (match.status === 'retake') return { text: 'Needs a clearer scan', tone: 'warn', detail };
  if (match.status === 'error') return { text: 'Could not check', tone: 'error', detail };
  return { text: 'No match', tone: 'none', detail };
}

function updatePendingCard() {
  if (!pendingCard) {
    pendingCard = document.createElement('figure');
    pendingCard.className = 'page pending';
    pendingCard.innerHTML = '<div class="page-thumb"><div class="pending-sheet"></div></div><figcaption>Scanning…</figcaption>';
  }
  const { percent, cancelled } = state.job;
  const known = typeof percent === 'number' && percent > 0;
  const sheet = pendingCard.querySelector('.pending-sheet');
  sheet.classList.toggle('indeterminate', !known);
  sheet.style.setProperty('--fill', known ? `${percent}%` : '0%');
  pendingCard.querySelector('figcaption').textContent = cancelled ? 'Cancelling…' : 'Scanning…';
  return pendingCard;
}

function renderToolbar() {
  const total = state.pages.length;
  const count = state.selected.size;
  $('pageCount').textContent = total ? plural(total, 'page') : 'No pages';
  $('selectionInfo').textContent = count ? `· ${count} selected` : '';
  $('selectAllBtn').textContent = count && count === total ? 'Select none' : 'Select all';
  $('selectAllBtn').disabled = !total;
  for (const id of ['rotateLeftBtn', 'rotateRightBtn', 'deleteBtn']) $(id).disabled = !count;
  grid.classList.toggle('selecting', count > 0);

  // With nothing selected, Identify checks every page that has no answer yet.
  const run = state.identify;
  const toCheck = count || state.pages.filter((p) => !p.match || p.match.status === 'error').length;
  const button = $('identifyBtn');
  button.hidden = Boolean(run);
  button.disabled = !toCheck;
  button.textContent = toCheck ? `Identify ${plural(toCheck, 'card')}` : total ? 'All identified' : 'Identify cards';
  button.title = !toCheck && total ? 'Select cards to check them again' : '';
  $('identifyStopBtn').hidden = !run;
  $('identifyStopBtn').disabled = Boolean(run?.stopping);
  $('identifyStatus').hidden = !run;
  $('identifyStatus').textContent = run?.status ?? '';
  $('game').disabled = Boolean(run);

  // Export follows the same rule: the selection, or every page when nothing is selected.
  const toExport = (count ? state.pages.filter((p) => state.selected.has(p.id)) : state.pages)
    .filter((p) => p.match?.status === 'candidates').length;
  $('exportBtn').disabled = !toExport;
  $('exportBtn').title = toExport
    ? `Download the top match of ${plural(toExport, 'card')} as a spreadsheet`
    : 'Identify cards to export them';
}

function toggleSelection(id, range) {
  const order = state.pages.map((p) => p.id);
  if (range && state.anchor && order.includes(state.anchor)) {
    const [from, to] = [order.indexOf(state.anchor), order.indexOf(id)].sort((a, b) => a - b);
    for (const pick of order.slice(from, to + 1)) state.selected.add(pick);
  } else if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    state.selected.add(id);
  }
  state.anchor = id;
  renderPages();
}

const selectedIds = () => state.pages.filter((p) => state.selected.has(p.id)).map((p) => p.id);

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.page:not(.pending)');
  if (!card || e.target.closest('.page-check')) return;
  const { id } = card.dataset;
  const action = e.target.closest('[data-act]')?.dataset.act;
  if (action === 'rotl') rotate([id], -90);
  else if (action === 'rotr') rotate([id], 90);
  else if (action === 'delete') removePages([id]);
  else if (e.target.closest('.page-thumb')) {
    // Once something is selected, clicks keep selecting instead of opening the viewer.
    if (state.selected.size || e.shiftKey || e.metaKey || e.ctrlKey) toggleSelection(id, e.shiftKey);
    else openViewer(id);
  }
});

grid.addEventListener('change', (e) => {
  if (!e.target.matches('.page-check input')) return;
  toggleSelection(e.target.closest('.page').dataset.id, false);
});

$('selectAllBtn').addEventListener('click', () => {
  const all = state.selected.size === state.pages.length;
  state.selected = new Set(all ? [] : state.pages.map((p) => p.id));
  renderPages();
});
$('rotateLeftBtn').addEventListener('click', () => rotate(selectedIds(), -90));
$('rotateRightBtn').addEventListener('click', () => rotate(selectedIds(), 90));
$('deleteBtn').addEventListener('click', () => removePages(selectedIds()));
$('identifyBtn').addEventListener('click', identify);
$('exportBtn').addEventListener('click', exportCsv);
$('identifyStopBtn').addEventListener('click', () => {
  api('POST', '/api/identify/cancel', {}).catch((err) => toast('error', err.message));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewer.open && narrow.matches && !$('summary').hidden) {
    setSummaryOpen(false);
  } else if (e.key === 'Escape' && !viewer.open && state.selected.size) {
    state.selected.clear();
    renderPages();
  }
});

async function rotate(ids, degrees) {
  if (!ids.length) return;
  try {
    await api('POST', '/api/pages/rotate', { ids, degrees });
  } catch (err) {
    toast('error', err.message);
  }
}

async function removePages(ids) {
  if (!ids.length) return;
  if (ids.length > 1 && !confirm(`Delete ${plural(ids.length, 'page')}? This can't be undone.`)) return;
  try {
    await api('POST', '/api/pages/delete', { ids });
  } catch (err) {
    toast('error', err.message);
  }
}

async function identify() {
  try {
    await api('POST', '/api/identify', { ids: selectedIds(), game: $('game').value });
  } catch (err) {
    toast('error', err.message);
  }
}

async function exportCsv() {
  try {
    const res = await api('POST', '/api/export', { ids: selectedIds() });
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `feeder-cards-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 40000); // Safari may still be reading it
  } catch (err) {
    toast('error', err.message);
  }
}

// Drag a page to reorder it.
let dragId = null;
let dropTarget = null;

const clearDropMarks = () => {
  for (const el of grid.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
};

grid.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.page:not(.pending)');
  if (!card) return;
  dragId = card.dataset.id;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});

grid.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const card = e.target.closest('.page:not(.pending)');
  clearDropMarks();
  dropTarget = null;
  if (!card || card.dataset.id === dragId) return;
  const rect = card.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  card.classList.add(after ? 'drop-after' : 'drop-before');
  dropTarget = { id: card.dataset.id, after };
});

grid.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!dragId || !dropTarget) return;
  const order = state.pages.map((p) => p.id).filter((id) => id !== dragId);
  order.splice(order.indexOf(dropTarget.id) + (dropTarget.after ? 1 : 0), 0, dragId);
  const byId = new Map(state.pages.map((p) => [p.id, p]));
  state.pages = order.map((id) => byId.get(id));
  renderPages();
  api('POST', '/api/pages/order', { ids: order }).catch((err) => toast('error', err.message));
});

grid.addEventListener('dragend', () => {
  cards.get(dragId)?.classList.remove('dragging');
  clearDropMarks();
  dragId = null;
  dropTarget = null;
});

// ---------------------------------------------------------------------------
// Viewer

function openViewer(id) {
  state.viewing = id;
  renderViewer();
  if (!viewer.open) viewer.showModal();
}

function renderViewer() {
  const index = state.pages.findIndex((p) => p.id === state.viewing);
  if (index < 0) {
    if (viewer.open) viewer.close();
    return;
  }
  const page = state.pages[index];
  const src = pageUrl(page);
  const img = $('viewerImg');
  if (img.getAttribute('src') !== src) img.src = src;
  img.alt = `Page ${index + 1}`;
  $('viewerTitle').textContent = `Page ${index + 1} of ${state.pages.length}`;
  $('viewerDownload').href = src;
  $('viewerDownload').download = `Page ${index + 1}${page.file.slice(page.file.lastIndexOf('.'))}`;
  viewer.querySelector('.prev').disabled = index === 0;
  viewer.querySelector('.next').disabled = index === state.pages.length - 1;
  renderMatch(page);
}

const MATCH_TITLES = {
  candidates: 'Possible matches',
  no_match: 'No match found',
  retake: 'Needs a clearer scan',
  error: 'Could not check this card',
};

function renderMatch(page) {
  const panel = $('viewerMatch');
  const busy = state.identify?.current === page.id;
  const { match } = page;
  panel.hidden = !match && !busy;
  renderRetry(page, busy);
  // Rebuild only when the answer changes, so candidate images don't flicker on unrelated updates.
  const key = `${page.id}:${busy}:${match?.checkedAt}`;
  if (panel.hidden || panel.dataset.key === key) return;
  panel.dataset.key = key;

  $('matchTitle').textContent = busy ? 'Identifying…' : MATCH_TITLES[match.status] ?? MATCH_TITLES.no_match;
  $('matchReason').textContent = busy ? '' : match.reason
    ?? (match.status === 'no_match' ? 'Try scanning it again, or choose the card game before identifying.' : '');
  $('candidates').replaceChildren(...(busy ? [] : match.candidates.map(candidateItem)));
}

/** Pages without a usable answer can be sent again, e.g. after rotating them or picking the card game. */
function renderRetry(page, busy) {
  const button = $('matchRetry');
  button.hidden = busy || !['retake', 'no_match', 'error'].includes(page.match?.status);
  button.disabled = Boolean(state.identify);
  button.title = state.identify ? 'Wait for the cards being identified to finish' : '';
}

$('matchRetry').addEventListener('click', async () => {
  const id = state.viewing;
  if (!id) return;
  $('matchRetry').disabled = true;
  try {
    await api('POST', '/api/identify', { ids: [id], game: $('game').value });
  } catch (err) {
    toast('error', err.message);
    renderViewer();
  }
});

function candidateItem(candidate) {
  const li = document.createElement('li');
  li.className = 'candidate';
  li.innerHTML = '<img alt="" loading="lazy" hidden><div><a class="candidate-name" target="_blank" rel="noopener noreferrer"></a><p class="candidate-meta"></p><p class="candidate-price"></p></div>';
  const img = li.querySelector('img');
  if (candidate.image) {
    img.src = candidate.image;
    img.hidden = false;
  }
  const name = li.querySelector('a');
  name.textContent = candidate.name;
  if (candidate.url) name.href = candidate.url;
  li.querySelector('.candidate-meta').textContent = [candidate.set, candidate.number, candidate.rarity].filter(Boolean).join(' · ');
  li.querySelector('.candidate-price').textContent = candidate.price
    ? [formatPrice(candidate.price), candidate.price.variant].filter(Boolean).join(' · ')
    : '';
  return li;
}

function formatPrice({ amount, currency }) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// ---------------------------------------------------------------------------
// Collection summary

const SUMMARY_KEY = 'feeder.summaryOpen';
const CURRENCY_KEY = 'feeder.currency';
const narrow = matchMedia('(max-width: 820px)');
let exchange = null; // { base, date, rates } once loaded
let exchangeError = '';

async function loadRates() {
  try {
    exchange = await api('GET', '/api/rates');
    exchangeError = '';
  } catch (err) {
    exchangeError = err.message;
  }
  renderSummary();
}

/** `price` in `currency`, or null when there's no rate for one side. */
function convert({ amount, currency: from }, to) {
  if (from === to) return amount;
  const r = exchange?.rates;
  return r?.[from] && r?.[to] ? (amount / r[from]) * r[to] : null;
}

/** The top match of an identified page, when it has a price. */
const pricedTop = (page) => (page.match?.status === 'candidates' && page.match.candidates[0]?.price ? page.match.candidates[0] : null);

/**
 * Totals prices in the chosen currency. TCGSDK quotes cards in different currencies, so prices are
 * converted; any that can't be (rates not loaded yet) are added per currency after it.
 */
function totalValue(list) {
  const to = $('summaryCurrency').value;
  let total = 0;
  let converted = 0;
  const rest = new Map();
  for (const page of list) {
    const top = pricedTop(page);
    if (!top) continue;
    const value = convert(top.price, to);
    if (value == null) rest.set(top.price.currency, (rest.get(top.price.currency) ?? 0) + top.price.amount);
    else { total += value; converted += 1; }
  }
  const parts = [...rest].map(([currency, amount]) => formatPrice({ amount, currency }));
  if (converted) parts.unshift(formatPrice({ amount: total, currency: to }));
  return parts.join(' + ');
}

/** A price in USD for sorting, falling back to the raw amount without rates. */
const sortValue = (page) => convert(pricedTop(page).price, 'USD') ?? pricedTop(page).price.amount;

function renderSummary() {
  const { pages } = state;
  const found = pages.filter((p) => p.match?.status === 'candidates');
  const priced = found.filter(pricedTop);
  $('statCards').textContent = pages.length;
  $('statFound').textContent = found.length;
  $('statMissing').textContent = pages.filter((p) => ['no_match', 'retake'].includes(p.match?.status)).length;
  $('statPending').textContent = pages.filter((p) => !p.match || p.match.status === 'error').length;

  $('summaryValue').textContent = totalValue(pages) || '—';
  const unpriced = found.length - priced.length;
  const to = $('summaryCurrency').value;
  const mixed = priced.some((p) => pricedTop(p).price.currency !== to);
  const rateNote = !mixed ? ''
    : exchange ? ` · rates of ${formatDate(exchange.date)}`
    : exchangeError ? ' · no exchange rates, so not converted' : ' · loading exchange rates…';
  $('summaryValueNote').textContent = !found.length ? 'Identify cards to see their value'
    : `${plural(priced.length, 'card')} priced${unpriced ? `, ${unpriced} without a price` : ''}${rateNote}`;
  $('summaryValueNote').title = mixed && exchangeError ? exchangeError : '';

  const selected = pages.filter((p) => state.selected.has(p.id));
  const selectionValue = totalValue(selected);
  $('summarySelection').hidden = !selected.length;
  $('summarySelection').textContent = `Selected: ${plural(selected.length, 'card')}${selectionValue ? ` · ${selectionValue}` : ''}`;

  const top = priced.sort((a, b) => sortValue(b) - sortValue(a)).slice(0, 8);
  $('topCards').replaceChildren(...top.map((page) => {
    const card = pricedTop(page);
    const li = document.createElement('li');
    li.innerHTML = '<button type="button"><span class="top-name"></span><span class="top-meta"></span><span class="top-price"></span></button>';
    li.querySelector('.top-name').textContent = card.name;
    li.querySelector('.top-meta').textContent = [card.set, card.number].filter(Boolean).join(' · ');
    const local = convert(card.price, to);
    li.querySelector('.top-price').textContent = formatPrice(card.price);
    li.querySelector('.top-price').title = local != null && card.price.currency !== to ? `≈ ${formatPrice({ amount: local, currency: to })}` : '';
    li.querySelector('button').addEventListener('click', () => {
      if (narrow.matches) setSummaryOpen(false);
      openViewer(page.id);
    });
    return li;
  }));
  $('topCardsEmpty').hidden = top.length > 0;
}

function setSummaryOpen(open, remember = true) {
  $('summary').hidden = !open;
  $('summaryScrim').hidden = !open || !narrow.matches;
  $('summaryToggle').setAttribute('aria-expanded', String(open));
  $('summaryToggle').classList.toggle('active', open);
  $('summaryToggle').title = open ? 'Hide collection summary' : 'Show collection summary';
  // On small screens it is a sheet over the page, so only remember the choice on wide ones.
  if (remember && !narrow.matches) try { localStorage.setItem(SUMMARY_KEY, String(open)); } catch {}
}

/** Docked and open by default on wide screens; a closed sheet on small ones. */
function resetSummary() {
  let saved = null;
  try { saved = localStorage.getItem(SUMMARY_KEY); } catch {}
  setSummaryOpen(!narrow.matches && saved !== 'false', false);
}

const formatDate = (iso) => {
  const date = iso && new Date(`${iso}T00:00:00`);
  return date && !Number.isNaN(date.valueOf()) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'today';
};

function initSummary() {
  let currency = null;
  try { currency = localStorage.getItem(CURRENCY_KEY); } catch {}
  if ([...$('summaryCurrency').options].some((o) => o.value === currency)) $('summaryCurrency').value = currency;
  $('summaryCurrency').addEventListener('change', () => {
    try { localStorage.setItem(CURRENCY_KEY, $('summaryCurrency').value); } catch {}
    renderSummary();
  });
  loadRates();
  $('summaryToggle').innerHTML = icon('panel');
  $('summaryClose').innerHTML = icon('close');
  $('summaryToggle').addEventListener('click', () => setSummaryOpen($('summary').hidden));
  $('summaryClose').addEventListener('click', () => setSummaryOpen(false));
  $('summaryScrim').addEventListener('click', () => setSummaryOpen(false));
  narrow.addEventListener('change', resetSummary);
  resetSummary();
}

function step(delta) {
  const index = state.pages.findIndex((p) => p.id === state.viewing);
  const next = state.pages[index + delta];
  if (next) openViewer(next.id);
}

viewer.addEventListener('close', () => { state.viewing = null; });

viewer.addEventListener('click', async (e) => {
  if (e.target === viewer) return viewer.close(); // backdrop
  const action = e.target.closest('[data-viewer]')?.dataset.viewer;
  const id = state.viewing;
  if (action === 'close') viewer.close();
  else if (action === 'prev') step(-1);
  else if (action === 'next') step(1);
  else if (action === 'rotl') rotate([id], -90);
  else if (action === 'rotr') rotate([id], 90);
  else if (action === 'delete') {
    const index = state.pages.findIndex((p) => p.id === id);
    const neighbour = state.pages[index + 1] ?? state.pages[index - 1];
    await removePages([id]);
    if (neighbour) openViewer(neighbour.id);
    else viewer.close();
  }
});

viewer.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

// ---------------------------------------------------------------------------
// Toasts

function toast(level, message) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<p></p><button type="button" aria-label="Dismiss">${icon('close', 14)}</button>`;
  el.querySelector('p').textContent = message;
  el.querySelector('button').addEventListener('click', () => el.remove());
  $('toasts').append(el);
  setTimeout(() => el.remove(), level === 'error' ? 12000 : 5000);
}

// ---------------------------------------------------------------------------
// Start

$('refreshDevices').innerHTML = icon('refresh');
$('refreshDevices').addEventListener('click', refreshDevices);
$('rotateLeftBtn').innerHTML = icon('rotateLeft');
$('rotateRightBtn').innerHTML = icon('rotateRight');
$('deleteBtn').innerHTML = icon('trash');
$('viewerDownload').innerHTML = icon('download');
const viewerIcons = { rotl: 'rotateLeft', rotr: 'rotateRight', delete: 'trash', close: 'close', prev: 'prev', next: 'next' };
for (const el of viewer.querySelectorAll('[data-viewer]')) el.innerHTML = icon(viewerIcons[el.dataset.viewer], el.classList.contains('nav') ? 20 : 16);

initSummary();
savedDevice = loadSettings().device ?? '';
renderPaperHint();
renderJob();
renderPages();
renderDevices();
connect();
refreshDevices();
