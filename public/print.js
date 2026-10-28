// Card labels: one 50 × 30 mm label per identified card, with its TCGSDK ID as a Code 128 barcode.
// The main page opens this with ?ids= (empty means every identified card) and ?currency=, which go on to /api/labels.
// The store name and branding are set in this page's bar and remembered in the browser.

const $ = (id) => document.getElementById(id);

const LABEL_SETTINGS_KEY = 'feeder.labels';

function loadLabelSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LABEL_SETTINGS_KEY)); } catch {}
  if (!saved) {
    // These used to be scan settings on the main page; carry them over once.
    try {
      const old = JSON.parse(localStorage.getItem('feeder.settings')) ?? {};
      saved = { storeName: old.storeName, hideBrand: old.hideBrand };
    } catch {}
  }
  $('storeName').value = typeof saved?.storeName === 'string' ? saved.storeName : '';
  $('hideBrand').checked = saved?.hideBrand === true;
}

function saveLabelSettings() {
  const settings = { storeName: $('storeName').value.trim(), hideBrand: $('hideBrand').checked };
  try { localStorage.setItem(LABEL_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatPrice({ amount, currency }) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// ---------------------------------------------------------------------------
// Code 128

// Bar and space widths, in modules, of each symbol value. 103–105 start code A, B or C; 106 stops.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START = { B: 104, C: 105 };
const SHIFT = { B: 100, C: 99 }; // switch to code B or C mid-barcode

/** Symbol values for printable ASCII `text`: code C packs runs of 4+ digits two to a symbol, code B takes the rest. */
function code128(text) {
  const values = [];
  let set = null;
  const use = (next) => {
    if (set !== next) values.push(set ? SHIFT[next] : START[next]);
    set = next;
  };
  for (let i = 0; i < text.length;) {
    const digits = /^\d*/.exec(text.slice(i))[0].length;
    if (digits >= 4) {
      use('C');
      for (const end = i + digits - (digits % 2); i < end; i += 2) values.push(Number(text.slice(i, i + 2)));
    } else {
      use('B');
      values.push(text.charCodeAt(i++) - 32);
    }
  }
  const check = values.reduce((sum, value, i) => sum + value * Math.max(i, 1), 0) % 103;
  return [...values, check, 106];
}

function barcodeSvg(text) {
  let x = 0;
  let bars = '';
  [...code128(text).map((value) => PATTERNS[value]).join('')].forEach((width, i) => {
    if (i % 2 === 0) bars += `M${x} 0h${width}v1h-${width}z`; // even elements are bars, odd ones spaces
    x += Number(width);
  });
  return `<svg viewBox="0 0 ${x} 1" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true"><path d="${bars}"/></svg>`;
}

// ---------------------------------------------------------------------------
// Labels

/** Puts the store name, the TCGFeedr logo or nothing at the top of a label. */
function renderBrand(el) {
  const logo = el.querySelector('.logo');
  const store = $('storeName').value.trim();
  el.querySelector('.label-head').hidden = $('hideBrand').checked;
  if (store) logo.textContent = store;
  else logo.innerHTML = '<b>TCG</b>Feedr';
  logo.title = store;
}

function renderBrands() {
  $('storeName').disabled = $('hideBrand').checked; // a name has no effect without branding
  for (const el of $('sheet').children) renderBrand(el);
}

function labelElement(label) {
  const el = $('labelTemplate').content.firstElementChild.cloneNode(true);
  renderBrand(el);
  el.querySelector('.label-kicker').textContent = [label.number, label.rarity, label.language, label.condition].filter(Boolean).join(' · ') || 'Card';
  el.querySelector('.label-set').textContent = label.set ?? '';
  el.querySelector('.label-name').textContent = label.name;
  el.querySelector('.label-price').textContent = label.price ? formatPrice(label.price) : 'No price';

  const printable = /^[ -~]+$/.test(label.code ?? '');
  el.querySelector('.label-bars').innerHTML = printable ? barcodeSvg(label.code) : '<p class="label-none">No TCGSDK ID</p>';
  el.querySelector('.label-id').textContent = printable ? label.code : '';
  return el;
}

async function load() {
  try {
    const res = await fetch(`/api/labels${location.search}`);
    const labels = await res.json();
    if (!res.ok) throw new Error(labels.error || `Request failed (${res.status}).`);
    $('sheet').replaceChildren(...labels.map(labelElement));
    $('info').textContent = labels.length ? `${plural(labels.length, 'label')} · 50 × 30mm · Code128` : 'No identified cards to label';
    $('printBtn').disabled = !labels.length;
  } catch (err) {
    $('info').textContent = `Could not load the labels: ${err.message}`;
  }
}

for (const input of [$('storeName'), $('hideBrand')]) {
  input.addEventListener('input', () => {
    renderBrands();
    saveLabelSettings();
  });
}

$('printBtn').addEventListener('click', () => window.print());
loadLabelSettings();
renderBrands();
load();
