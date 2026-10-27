// Card labels: one 50 × 30 mm label per identified card, with its TCGSDK ID as a Code 128 barcode.
// The main page opens this with ?ids= (empty means every identified card) and ?currency=, which go on to /api/labels,
// and ?store=, the store name printed in place of the TCGFeedr logo.

const $ = (id) => document.getElementById(id);

const store = new URLSearchParams(location.search).get('store')?.trim().slice(0, 40);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatPrice({ amount, currency }) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** "27 OCT 2026 16:17" in local time; the label upper-cases it. */
function stamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return '';
  const two = (n) => String(n).padStart(2, '0');
  const month = date.toLocaleString('en', { month: 'short' });
  return `${date.getDate()} ${month} ${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`;
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

function labelElement(label) {
  const el = $('labelTemplate').content.firstElementChild.cloneNode(true);
  if (store) {
    const logo = el.querySelector('.logo');
    logo.textContent = store;
    logo.title = store;
  }
  const date = el.querySelector('time');
  date.dateTime = label.checkedAt ?? '';
  date.textContent = stamp(label.checkedAt);
  el.querySelector('.label-kicker').textContent = [label.number, label.rarity, label.language].filter(Boolean).join(' · ') || 'Card';
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

$('printBtn').addEventListener('click', () => window.print());
load();
