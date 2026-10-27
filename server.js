// Feeder — a local web UI for a USB document scanner (built for the HP ScanJet Pro 2000).
// Serves the UI, drives the native ImageCaptureCore helper, and pushes scanned pages to
// the browser over Server-Sent Events as they come off the feeder.

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {} // optional; holds the TCGSDK token

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const HELPER = process.env.SCAN_HELPER || path.join(ROOT, 'bin', 'scanhelper');
const DATA_DIR = path.resolve(process.env.SCANS_DIR || path.join(ROOT, 'scans'));
const PAGES_DIR = path.join(DATA_DIR, 'pages');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const INCOMING_DIR = path.join(DATA_DIR, 'incoming');
const MATCHES_DIR = path.join(DATA_DIR, 'matches');
const INDEX_FILE = path.join(DATA_DIR, 'pages.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TCGSDK_API = (process.env.TCGSDK_API_URL || 'https://tcgsdk.com/api').replace(/\/+$/, '');
const TCGSDK_KEY = process.env.TCGSDK_API_KEY?.trim() || '';

const exec = promisify(execFile);

let pages = []; // in display order
let job = null; // the scan in progress, if any
let identifying = null; // the card identification run in progress, if any
const clients = new Set(); // open SSE responses

// ---------------------------------------------------------------------------
// Page store

const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

async function loadIndex() {
  try {
    const saved = JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
    pages = saved.filter((p) => existsSync(path.join(PAGES_DIR, p.file)));
  } catch {
    pages = [];
  }
  await refreshSummaries();
}

/** Rebuilds summaries saved before Feeder kept each match's language and print prices. */
async function refreshSummaries() {
  let changed = false;
  for (const page of pages) {
    if (page.match?.status !== 'candidates' || page.match.candidates.every((c) => 'language' in c)) continue;
    try {
      const raw = JSON.parse(await fs.readFile(matchPath(page), 'utf8'));
      page.match = { ...toMatch(raw), checkedAt: page.match.checkedAt };
      changed = true;
    } catch {} // no full answer kept; leave the old summary
  }
  if (changed) await saveIndex();
}

async function saveIndex() {
  const tmp = `${INDEX_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(pages, null, 2));
  await fs.rename(tmp, INDEX_FILE);
}

const thumbPath = (page) => path.join(THUMBS_DIR, `${page.id}.jpg`);
const matchPath = (page) => path.join(MATCHES_DIR, `${page.id}.json`);

async function makeThumb(page) {
  await exec('sips', ['-Z', '480', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75',
    path.join(PAGES_DIR, page.file), '--out', thumbPath(page)]);
}

async function imageSize(file) {
  const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  return {
    width: Number(stdout.match(/pixelWidth: (\d+)/)?.[1]) || null,
    height: Number(stdout.match(/pixelHeight: (\d+)/)?.[1]) || null,
  };
}

/** Moves a freshly scanned file into the store and announces it. */
async function ingest(src, meta) {
  const id = newId();
  const file = id + (path.extname(src).toLowerCase() === '.png' ? '.png' : '.jpg');
  await fs.rename(src, path.join(PAGES_DIR, file));
  const page = { id, file, rev: 0, createdAt: new Date().toISOString(), ...meta };
  await makeThumb(page);
  Object.assign(page, await imageSize(path.join(PAGES_DIR, file)));
  pages.push(page);
  await saveIndex();
  broadcast('pages', pages);
}

async function rotatePages(ids, degrees) {
  for (const page of pages.filter((p) => ids.includes(p.id))) {
    const quality = page.file.endsWith('.jpg') ? ['-s', 'formatOptions', '92'] : [];
    await exec('sips', ['-r', String(degrees), ...quality, path.join(PAGES_DIR, page.file)]);
    await exec('sips', ['-r', String(degrees), thumbPath(page)]);
    if (Math.abs(degrees) % 180 === 90) [page.width, page.height] = [page.height, page.width];
    page.rev += 1;
  }
  await saveIndex();
  broadcast('pages', pages);
}

async function deletePages(ids) {
  const doomed = pages.filter((p) => ids.includes(p.id));
  pages = pages.filter((p) => !ids.includes(p.id));
  await saveIndex();
  broadcast('pages', pages);
  await Promise.all(doomed.flatMap((p) => [
    fs.rm(path.join(PAGES_DIR, p.file), { force: true }),
    fs.rm(thumbPath(p), { force: true }),
    fs.rm(matchPath(p), { force: true }),
  ]));
}

async function reorderPages(ids) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  // Pages missing from `ids` (e.g. scanned mid-drag) keep their place at the end.
  pages.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  await saveIndex();
  broadcast('pages', pages);
}

// ---------------------------------------------------------------------------
// Scanner helper

let listing = null;

function listScanners() {
  if (!existsSync(HELPER)) throw httpError(500, 'The scanner helper is not built yet. Run "npm run build" and restart.');
  // Share one helper run between concurrent requests.
  listing ??= exec(HELPER, ['list'], { timeout: 15000 })
    .then(({ stdout }) => JSON.parse(stdout.trim().split('\n').pop()).devices ?? [])
    .finally(() => { listing = null; });
  return listing;
}

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function startScan(body) {
  if (job) throw httpError(409, 'A scan is already running.');
  if (!existsSync(HELPER)) throw httpError(500, 'The scanner helper is not built yet. Run "npm run build" and restart.');

  const settings = {
    device: typeof body.device === 'string' ? body.device : '',
    resolution: oneOf(Number(body.resolution), [150, 200, 300, 400, 600], 300),
    mode: oneOf(body.mode, ['color', 'gray', 'bw'], 'color'),
    paper: oneOf(body.paper, ['a4', 'letter', 'legal', 'tcg'], 'a4'),
    duplex: body.duplex === true,
  };
  const id = newId();
  const outDir = path.join(INCOMING_DIR, id);
  const args = ['scan', '--out', outDir, '--resolution', String(settings.resolution),
    '--mode', settings.mode, '--paper', settings.paper];
  if (settings.device) args.push('--device', settings.device);
  if (settings.duplex) args.push('--duplex');

  const proc = spawn(HELPER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job = { id, proc, settings, status: 'Starting…', count: 0, percent: null, cancelled: false };
  broadcastJob();

  let failure = null;
  let stderr = '';
  let ingesting = Promise.resolve(); // keeps pages in feeder order

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    switch (event.type) {
      case 'status':
        job.status = event.message;
        break;
      case 'progress':
        job.percent = event.percent;
        break;
      case 'page':
        job.count = event.index;
        job.percent = null;
        ingesting = ingesting
          .then(() => ingest(event.path, { scan: id, resolution: event.resolution, mode: settings.mode }))
          .catch((err) => notify('error', `Could not save page ${event.index}: ${err.message}`));
        break;
      case 'warning':
        notify('warning', event.message);
        break;
      case 'error':
        failure = event.message;
        break;
    }
    broadcastJob();
  });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  proc.on('error', (err) => { failure = `Could not start the scanner helper: ${err.message}`; });
  proc.on('close', async (code) => {
    await ingesting;
    await fs.rm(outDir, { recursive: true, force: true });
    const { count, cancelled } = job;
    job = null;
    broadcastJob();
    if (failure) notify('error', failure);
    else if (code !== 0 && !cancelled) notify('error', stderr.trim() || `The scanner helper stopped unexpectedly (code ${code}).`);
    broadcast('done', { pages: count, cancelled });
  });
}

function cancelScan() {
  if (!job) return;
  job.cancelled = true;
  job.status = 'Cancelling…';
  job.proc.kill('SIGTERM');
  broadcastJob();
}

// ---------------------------------------------------------------------------
// Card identification: sends pages to the TCGSDK scanner API one at a time.
// https://tcgsdk.com/docs/scanner-scan

const GAMES = ['pokemon', 'magic', 'onepiece', 'yugioh', 'lorcana', 'digimon', 'gundam', 'hololive', 'riftbound', 'ultraman'];
const MAX_UPLOAD_BYTES = 10e6;
const MAX_UPLOAD_PIXELS = 40e6;
const MAX_RETRY_WAIT = 120; // seconds; a longer Retry-After means the daily allowance is gone

/** Pages that don't have a usable answer yet. */
const unidentified = () => pages.filter((p) => !p.match || p.match.status === 'error');

async function startIdentify(body) {
  if (identifying) throw httpError(409, 'Cards are already being identified.');
  if (!TCGSDK_KEY) throw httpError(400, 'Add your TCGSDK API token to a .env file as TCGSDK_API_KEY=… and restart Feeder.');
  const wanted = ids(body);
  const queue = wanted.length ? pages.filter((p) => wanted.includes(p.id)) : unidentified();
  if (!queue.length) throw httpError(400, 'Every card has been identified. Select cards to check them again.');
  const game = oneOf(body.game, GAMES, '');
  await checkScannerReady(game);
  if (identifying) throw httpError(409, 'Cards are already being identified.'); // started during the check

  identifying = {
    ids: queue.map((p) => p.id),
    done: 0,
    current: null,
    status: 'Starting…',
    game,
    abort: new AbortController(),
  };
  broadcastIdentify();
  runIdentify(identifying);
}

/** Fails fast when TCGSDK can't recognise cards yet. The capabilities call is free; a scan is not. */
async function checkScannerReady(game) {
  let res;
  try {
    res = await fetch(`${TCGSDK_API}/scanner/capabilities`, {
      headers: { Authorization: `Bearer ${TCGSDK_KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw httpError(502, `Could not reach TCGSDK: ${err.cause?.message ?? err.message}`);
  }
  if (res.status === 401) throw httpError(400, 'TCGSDK did not accept the API token. Check TCGSDK_API_KEY in .env and restart Feeder.');
  if (!res.ok) return; // let the scans themselves report the problem

  const scanner = (await res.json().catch(() => null))?.data;
  if (scanner?.enabled === false) throw httpError(503, 'The TCGSDK card scanner is switched off. Try again later.');
  if (!Array.isArray(scanner?.coverage)) return;
  const coverage = scanner.coverage.filter((c) => !game || c.game === game);
  if (!coverage.some((c) => c.indexed > 0)) {
    const which = game ? `${coverage[0]?.name ?? game} cards` : 'any cards';
    throw httpError(503, `The TCGSDK card scanner can't recognise ${which} yet: none have been indexed. Try again later.`);
  }
}

function cancelIdentify() {
  if (!identifying) return;
  identifying.status = 'Stopping…';
  identifying.abort.abort();
  broadcastIdentify();
}

const checking = (run) => `Checking card ${run.done + 1} of ${run.ids.length}…`;

async function runIdentify(run) {
  const tally = { candidates: 0, no_match: 0, retake: 0, error: 0 };
  let failure = null;
  try {
    for (const id of run.ids) {
      run.abort.signal.throwIfAborted();
      const page = pages.find((p) => p.id === id);
      if (page) {
        run.current = id;
        run.status = checking(run);
        broadcastIdentify();
        const { match, raw } = await identifyPage(page, run);
        tally[match.status] += 1;
        if (pages.includes(page)) { // it may have been deleted during the request
          page.match = match;
          // Keep the full answer for troubleshooting; pages.json only stores a summary.
          if (raw) await fs.writeFile(matchPath(page), JSON.stringify(raw, null, 2));
          await saveIndex();
          broadcast('pages', pages);
        }
      }
      run.done += 1;
    }
  } catch (err) {
    if (err.name !== 'AbortError') failure = err.message;
  } finally {
    identifying = null;
    broadcastIdentify();
  }

  if (failure) notify('error', failure);
  const checked = Object.values(tally).reduce((sum, n) => sum + n, 0);
  if (!checked) return;
  const parts = [`${tally.candidates} found`];
  if (tally.no_match) parts.push(`${tally.no_match} not found`);
  if (tally.retake) parts.push(`${tally.retake} need a clearer scan`);
  if (tally.error) parts.push(`${tally.error} could not be checked`);
  const cards = `${checked} card${checked === 1 ? '' : 's'}`;
  notify('ok', `${run.done < run.ids.length ? 'Stopped after' : 'Checked'} ${cards}: ${parts.join(', ')}.`);
}

/** Identifies one page. Returns its match; throws when the whole run has to stop. */
async function identifyPage(page, run) {
  let image;
  try {
    image = await uploadImage(page);
  } catch (err) {
    return failed(`Could not read the scan: ${err.message}`);
  }

  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append('image', image, image.type === 'image/png' ? 'card.png' : 'card.jpg');
    if (run.game) form.append('game', run.game);
    form.append('cropped', '0'); // scans keep a margin around the card

    let res;
    try {
      res = await fetch(`${TCGSDK_API}/scans`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TCGSDK_KEY}`, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(60_000)]),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') return failed('TCGSDK took too long to answer.');
      if (err.name === 'AbortError') throw err;
      throw new Error(`Could not reach TCGSDK: ${err.cause?.message ?? err.message}`);
    }
    const data = await res.json().catch(() => null);
    if (res.ok) return { match: toMatch(data), raw: data };

    // Per-minute limits and a busy scanner clear up quickly, so wait as told and try again.
    const retryAfter = Number(res.headers.get('retry-after'));
    if ((res.status === 429 || res.status === 503) && retryAfter <= MAX_RETRY_WAIT && attempt < 5) {
      const seconds = Math.max(1, Math.ceil(retryAfter));
      run.status = res.status === 429
        ? `Waiting ${seconds}s for TCGSDK's per-minute limit…`
        : `TCGSDK is busy. Retrying in ${seconds}s…`;
      broadcastIdentify();
      await sleep(seconds * 1000, null, { signal: run.abort.signal });
      run.status = checking(run);
      broadcastIdentify();
      continue;
    }

    const message = firstText(data?.message, data?.error) ?? `HTTP ${res.status}`;
    if (res.status === 422) {
      return failed(firstText(...Object.values(data?.errors ?? {}).flat()) ?? message);
    }
    if (res.status === 401) throw new Error('TCGSDK did not accept the API token. Check TCGSDK_API_KEY in .env and restart Feeder.');
    if (res.status === 403) throw new Error(`TCGSDK refused the request: ${message}`);
    if (res.status === 429) {
      const wait = retryAfter >= 3600 ? `${Math.round(retryAfter / 3600)} h` : `${Math.ceil(retryAfter / 60)} min`;
      throw new Error(`TCGSDK's scan limit is used up${retryAfter > 0 ? `. It resets in about ${wait}` : ''}.`);
    }
    if (res.status === 503) throw new Error(`The TCGSDK card scanner is unavailable right now (${message}). Try again later.`);
    throw new Error(`TCGSDK error (${res.status}): ${message}`);
  }
}

const failed = (reason) => ({ match: { status: 'error', reason, candidates: [], checkedAt: new Date().toISOString() }, raw: null });

/** The page image as an upload, shrunk first if it is over TCGSDK's 10 MB / 40 MP limits. */
async function uploadImage(page) {
  const file = path.join(PAGES_DIR, page.file);
  const { size } = await fs.stat(file);
  if (size <= MAX_UPLOAD_BYTES && (page.width ?? 0) * (page.height ?? 0) <= MAX_UPLOAD_PIXELS) {
    return new Blob([await fs.readFile(file)], { type: TYPES[path.extname(file)] });
  }
  const out = path.join(os.tmpdir(), `feeder-${newId()}.jpg`);
  try {
    await exec('sips', ['-Z', '3000', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', file, '--out', out]);
    return new Blob([await fs.readFile(out)], { type: 'image/jpeg' });
  } finally {
    await fs.rm(out, { force: true });
  }
}

function toMatch(data) {
  const result = data?.data ?? {};
  const candidates = (Array.isArray(result.candidates) ? result.candidates : []).map(toCandidate);
  let status = oneOf(result.status, ['candidates', 'no_match', 'retake'], 'no_match');
  if (status === 'candidates' && !candidates.length) status = 'no_match';
  return { status, reason: firstText(result.reason), candidates, checkedAt: new Date().toISOString() };
}

/** Flattens a candidate to what the UI shows. The Product shape is only partly documented, so try likely names. */
function toCandidate(candidate) {
  const product = candidate?.product ?? {};
  const list = (value) => (Array.isArray(value) ? value : []);
  // Prices live on each print variant. Prefer the print the scanner matched.
  const variants = list(product.variants);
  const matched = variants.filter((v) => v?.name === candidate?.matched_print_key);
  const prices = [...(matched.length ? matched : variants).flatMap((v) => list(v?.prices)), ...list(product.prices)];
  const price = prices.find((p) => typeof p?.market === 'number');
  return {
    id: product.id ?? null,
    name: firstText(product.name, product.name_original) ?? 'Unknown card',
    number: firstText(product.serial, product.number, product.card_number),
    rarity: firstText(product.rarity?.name, product.rarity),
    set: firstText(product.set?.name, product.set_name, product.set),
    language: firstText(product.language, product.set?.language?.language)?.toUpperCase() ?? null,
    image: tcgsdkUrl(firstText(product.image, product.image_url, product.images?.front, product.images?.large)),
    price: price ? { amount: price.market, currency: firstText(price.currency) ?? 'USD', variant: firstText(price.variant) } : null,
    score: typeof candidate?.score === 'number' ? candidate.score : null,
    url: tcgsdkUrl(candidate?.url),
  };
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'number' || (typeof value === 'string' && value.trim())) return String(value).trim();
  }
  return null;
}

/** An absolute http(s) link, resolving paths against TCGSDK; anything else is dropped. */
function tcgsdkUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, TCGSDK_API);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CSV export of identified cards

const CSV_HEADER = ['TCGSDK ID', 'Name', 'Set', 'Price', 'Currency', 'Language'];

function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Spreadsheet apps run text cells that start like a formula.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row per identified page, using its top match. Only the given pages when `wanted` isn't empty. */
function exportCsv(wanted) {
  const rows = pages
    .filter((p) => (!wanted.length || wanted.includes(p.id)) && p.match?.status === 'candidates')
    .map(({ match: { candidates: [top] } }) =>
      [top.id, top.name, top.set, top.price?.amount, top.price?.currency, top.language]);
  return [CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function sendCsv(res, csv) {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`\uFEFF${csv}`); // the BOM makes Excel read Japanese names as UTF-8
}

// ---------------------------------------------------------------------------
// Server-Sent Events

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(message);
}

const publicJob = () => job && {
  id: job.id, status: job.status, pages: job.count, percent: job.percent,
  cancelled: job.cancelled, settings: job.settings,
};

const broadcastJob = () => broadcast('job', publicJob());
const notify = (level, message) => broadcast('notice', { level, message });

const publicIdentify = () => identifying && {
  ids: identifying.ids, done: identifying.done, current: identifying.current,
  status: identifying.status, stopping: identifying.abort.signal.aborted,
};

const broadcastIdentify = () => broadcast('identify', publicIdentify());

function openEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: pages\ndata: ${JSON.stringify(pages)}\n\n`);
  res.write(`event: job\ndata: ${JSON.stringify(publicJob())}\n\n`);
  res.write(`event: identify\ndata: ${JSON.stringify(publicIdentify())}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function sendFile(res, file, headers = {}) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw httpError(404, 'Not found');
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    ...headers,
  });
  createReadStream(file).pipe(res);
}

async function readJson(req) {
  // Requiring a JSON content type forces a CORS preflight, so other websites can't trigger scans.
  if (!req.headers['content-type']?.startsWith('application/json')) throw httpError(415, 'Expected a JSON body.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e6) throw httpError(413, 'Request body too large.');
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw httpError(400, 'Invalid JSON.'); }
}

const ids = (body) => (Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []);

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const loopbackOnly = LOOPBACK_NAMES.has(HOST);

async function handle(req, res) {
  // Bound to localhost: reject other Host headers so DNS-rebinding pages can't read your scans.
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (loopbackOnly && !LOOPBACK_NAMES.has(hostname)) throw httpError(403, 'Forbidden host.');

  const { pathname } = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${pathname}`;

  switch (route) {
    case 'GET /api/events': return openEvents(req, res);
    case 'GET /api/scanners': return sendJson(res, 200, { devices: await listScanners() });
    case 'POST /api/scan': startScan(await readJson(req)); return sendJson(res, 202, publicJob());
    case 'POST /api/scan/cancel': cancelScan(); return sendJson(res, 200, {});
    case 'POST /api/pages/delete': await deletePages(ids(await readJson(req))); return sendJson(res, 200, {});
    case 'POST /api/pages/order': await reorderPages(ids(await readJson(req))); return sendJson(res, 200, {});
    case 'POST /api/pages/rotate': {
      const body = await readJson(req);
      const degrees = oneOf(Number(body.degrees), [90, -90, 180], 90);
      await rotatePages(ids(body), degrees);
      return sendJson(res, 200, {});
    }
    case 'POST /api/identify': await startIdentify(await readJson(req)); return sendJson(res, 202, publicIdentify());
    case 'POST /api/identify/cancel': cancelIdentify(); return sendJson(res, 200, {});
    case 'POST /api/export': return sendCsv(res, exportCsv(ids(await readJson(req))));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(404, 'Not found');

  const scan = pathname.match(/^\/scans\/(pages|thumbs)\/([a-z0-9-]+\.(?:jpg|png))$/);
  if (scan) {
    const dir = scan[1] === 'pages' ? PAGES_DIR : THUMBS_DIR;
    // URLs carry ?v=<rev>, so a rotated page gets a new URL and these can be cached forever.
    return sendFile(res, path.join(dir, scan[2]), { 'Cache-Control': 'private, max-age=31536000, immutable' });
  }

  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Not found');
  return sendFile(res, file);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    const status = err.status ?? (err instanceof URIError ? 400 : 500);
    if (status === 500) console.error(err);
    sendJson(res, status, { error: err.message });
  });
});

// ---------------------------------------------------------------------------
// Startup

await Promise.all([PAGES_DIR, THUMBS_DIR, MATCHES_DIR].map((dir) => fs.mkdir(dir, { recursive: true })));
await fs.rm(INCOMING_DIR, { recursive: true, force: true });
await loadIndex();

if (!existsSync(HELPER)) console.warn(`⚠️  Scanner helper missing at ${HELPER}. Run "npm run build".`);
if (!TCGSDK_KEY) console.warn('⚠️  TCGSDK_API_KEY is not set, so "Identify cards" is unavailable. Add it to .env.');

server.listen(PORT, HOST, () => {
  const shown = loopbackOnly ? 'localhost' : HOST;
  console.log(`Feeder is running at http://${shown}:${PORT}`);
  console.log(`Scans are stored in ${DATA_DIR}`);
});

function shutdown() {
  // Let the helper close its scanner session so the device isn't left locked.
  if (job) job.proc.kill('SIGTERM');
  identifying?.abort.abort();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
