import './style.css';
import { Chain, Mempool, Metric, ago, backfill, fmtBtc, fmtDate, fmtInt, fmtUsd, liveFeed, livePrice, loadChain, priceDays, putBlock, refreshPrice, api } from './data';
import { View, blockPos, poolColor } from './view';
import { Sound, renderEvents } from './audio';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CAPTURE = new URLSearchParams(location.search).has('capture');   // frame-exact stepping for recording demos
const sound = new Sound();

/*
 * The big moments. On-chain events use their exact block; everything else is placed on the first
 * block of that UTC day. Price milestones are derived from the price data at boot.
 */
type Kind = 'protocol' | 'market' | 'world';
type Ev = { h: number; name: string; desc: string; kind: Kind; major?: boolean };
const FIXED: { h?: number; date?: string; name: string; desc: string; kind: Kind; major?: boolean }[] = [
  { h: 0, name: 'Genesis block', desc: 'Satoshi mines the first block. Its coinbase quotes a headline about bank bailouts.', kind: 'protocol', major: true },
  { h: 170, name: 'First payment', desc: 'Satoshi sends 10 BTC to Hal Finney, the first transaction between two people.', kind: 'protocol' },
  { h: 57043, name: 'Pizza Day', desc: 'Laszlo Hanyecz pays 10,000 BTC for two pizzas, the first real-world purchase.', kind: 'world', major: true },
  { h: 74638, name: 'Value overflow bug', desc: 'A bug creates 184 billion BTC out of thin air. It is fixed within hours and the chain is rewritten.', kind: 'protocol' },
  { date: '2011-06-19', name: 'Mt. Gox hacked', desc: 'The biggest exchange is hacked and the price briefly crashes to a cent.', kind: 'world' },
  { h: 210000, name: 'First halving', desc: 'The block reward drops from 50 to 25 BTC.', kind: 'protocol', major: true },
  { h: 225430, name: 'Accidental chain split', desc: 'A software upgrade splits the chain in two. Miners roll back to keep a single history.', kind: 'protocol' },
  { date: '2013-10-02', name: 'Silk Road shut down', desc: 'The FBI closes the Silk Road marketplace and seizes its bitcoin.', kind: 'world' },
  { date: '2014-02-24', name: 'Mt. Gox collapses', desc: 'Mt. Gox halts withdrawals and goes under, with roughly 850,000 BTC missing.', kind: 'world', major: true },
  { h: 420000, name: 'Second halving', desc: 'The block reward drops to 12.5 BTC.', kind: 'protocol', major: true },
  { h: 478558, name: 'Bitcoin Cash splits off', desc: 'A hard fork over block size creates Bitcoin Cash. This is the last block the two chains share.', kind: 'protocol' },
  { h: 481824, name: 'SegWit activates', desc: 'Segregated Witness lets blocks grow past the old 1 MB limit.', kind: 'protocol' },
  { date: '2020-03-12', name: 'COVID crash', desc: 'Markets panic as the pandemic spreads and bitcoin loses nearly half its value in two days.', kind: 'world' },
  { h: 630000, name: 'Third halving', desc: 'The block reward drops to 6.25 BTC.', kind: 'protocol', major: true },
  { date: '2020-08-11', name: 'MicroStrategy buys in', desc: 'The first public company to hold bitcoin as its main treasury reserve.', kind: 'world' },
  { date: '2021-02-08', name: 'Tesla buys $1.5B', desc: 'Tesla reveals a $1.5 billion bitcoin purchase.', kind: 'world' },
  { date: '2021-04-14', name: 'Coinbase goes public', desc: 'The largest US exchange lists on the Nasdaq.', kind: 'world' },
  { date: '2021-09-07', name: 'El Salvador adopts bitcoin', desc: 'The first country to make bitcoin legal tender.', kind: 'world' },
  { h: 709632, name: 'Taproot activates', desc: 'Schnorr signatures and more flexible, more private scripts.', kind: 'protocol' },
  { date: '2022-05-09', name: 'Terra collapses', desc: 'The Terra/Luna stablecoin implodes and drags the whole market down.', kind: 'world' },
  { date: '2022-11-11', name: 'FTX collapses', desc: 'Crypto exchange FTX files for bankruptcy.', kind: 'world' },
  { h: 767430, name: 'First inscription', desc: 'The first Ordinals inscription. Data-heavy transactions start filling blocks toward 4 MB.', kind: 'protocol' },
  { date: '2024-01-10', name: 'Spot ETFs approved', desc: 'The SEC approves US spot bitcoin ETFs, opening the door to Wall Street money.', kind: 'world', major: true },
  { h: 840000, name: 'Fourth halving', desc: 'The reward drops to 3.125 BTC. Runes launch in the same block and fees spike.', kind: 'protocol', major: true },
  { date: '2025-03-06', name: 'US Strategic Bitcoin Reserve', desc: 'A US executive order creates a national bitcoin reserve.', kind: 'world' },
];
let EVENTS: Ev[] = [];
function buildEvents() {
  const out: Ev[] = [];
  for (const e of FIXED) {
    const h = e.h ?? firstBlockOn(Date.parse(e.date + 'T00:00:00Z') / 1000);
    if (h >= 0 && h < chain.n) out.push({ h, name: e.name, desc: e.desc, kind: e.kind, major: e.major });
  }
  // price milestones and cycle peaks, straight from the price data
  const P = priceDays(), dayT = (i: number) => (P.d0 + i) * 86400;
  const firstAbove = (v: number) => P.usd.findIndex(x => x >= v);
  for (const [v, name, desc] of [
    [1, 'Bitcoin hits $1', 'One bitcoin is worth a dollar for the first time.'],
    [1000, 'Bitcoin hits $1,000', 'The first time bitcoin trades above $1,000.'],
    [10000, 'Bitcoin hits $10,000', 'The 2017 bubble pushes bitcoin past $10,000.'],
    [100000, 'Bitcoin hits $100,000', 'Bitcoin closes above $100,000 for the first time.'],
  ] as [number, string, string][]) {
    const i = firstAbove(v);
    if (i >= 0) out.push({ h: firstBlockOn(dayT(i)), name, desc, kind: 'market', major: v === 100000 });
  }
  const peak = (from: string, to: string) => {
    const a = Math.floor(Date.parse(from) / 864e5) - P.d0, b = Math.min(P.usd.length - 1, Math.floor(Date.parse(to) / 864e5) - P.d0);
    let best = a; for (let i = a; i <= b; i++) if (P.usd[i] > P.usd[best]) best = i;
    return best;
  };
  if (P.usd.length) {
    const p17 = peak('2017-06-01', '2018-06-01'), p21 = peak('2021-01-01', '2022-01-01');
    out.push({ h: firstBlockOn(dayT(p17)), name: `2017 peak · ${fmtUsd(P.usd[p17])}`, desc: 'The 2017 bubble tops out. The price falls more than 80% over the next year.', kind: 'market' });
    out.push({ h: firstBlockOn(dayT(p21)), name: `2021 peak · ${fmtUsd(P.usd[p21])}`, desc: 'The 2021 cycle tops out before the 2022 crypto winter.', kind: 'market' });
    let ath = 0; P.usd.forEach((x, i) => { if (x > P.usd[ath]) ath = i; });
    out.push({ h: firstBlockOn(dayT(ath)), name: `All-time high · ${fmtUsd(P.usd[ath])}`, desc: 'The highest daily price bitcoin has ever reached.', kind: 'market', major: true });
  }
  EVENTS = out.filter(e => e.h >= 0 && e.h < chain.n).sort((a, b) => a.h - b.h);
}
const eventAt = (h: number) => EVENTS.find(e => e.h === h);
const subsidy = (h: number) => 50 / Math.pow(2, Math.floor(h / 210000));
const fmtSize = (b: number) => (b >= 1e6 ? (b / 1e6).toFixed(2) + ' MB' : (b / 1e3).toFixed(0) + ' kB');
const poolName = (i: number) => chain.pools[i].replace(/ Pool$/i, '');
const KIND_COLOR: Record<Kind, string> = { protocol: 'var(--teal)', market: 'var(--orange)', world: '#A78BFA' };

let chain: Chain, view: View;
let selected = -1;
let liveState: 'on' | 'off' | 'wait' = 'wait';
let mempool: Mempool | null = null;

function firstBlockOn(t: number) {
  let lo = 0, hi = chain.n - 1;
  if (t > chain.time[hi]) return -1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (chain.time[m] < t) lo = m + 1; else hi = m; }
  return lo;
}

/* ============================== boot ============================== */
async function boot() {
  const txt = $('#loader-text');
  try {
    chain = await loadChain(f => { txt.textContent = `Downloading the blockchain… ${Math.round(f * 100)}%`; });
  } catch (e) { txt.textContent = 'Could not load block data. Please refresh.'; console.error(e); return; }
  buildEvents();
  view = new View($('#gl') as HTMLCanvasElement, $('#labels'), chain);
  view.setEvents(EVENTS);
  view.onUserMove = () => hideHint();
  view.onTxLand = () => sound.tick();
  $('#loader').classList.add('done');

  const m = location.pathname.match(/^\/b\/(\d+)/);
  const deep = m ? +m[1] : parseInt(location.hash.slice(1));
  if (m) history.replaceState(null, '', `/#${deep}`);
  if (!isNaN(deep) && deep >= 0 && deep < chain.n) {
    const { cam, target } = view.liveFrame();
    view.camera.position.copy(cam); view.controls.target.copy(target);
    select(deep);
  } else if (reduceMotion) {
    const { cam, target } = view.liveFrame();
    view.camera.position.copy(cam); view.controls.target.copy(target);
  } else {
    // open on the whole coil growing from 2009 to today, then glide down to the live tip
    const R = view.radius();
    view.camera.position.set(0, R * 2.6, R * 1.2); view.controls.target.set(0, 0, 0);
    view.playReveal();
    introAt = 3.6;
  }

  initChrome(); initColor(); initTimeline(); initPointer(); initSearch(); initKeys();
  renderLive(); renderSubtitle(); renderPending();
  setInterval(() => { renderLive(); renderPending(); }, 1000);
  setInterval(() => refreshPrice().then(renderLive), 60000);
  refreshPrice().then(renderLive);
  setTimeout(hideHint, 18000);

  if (CAPTURE) {
    const log: [number, string, unknown[]][] = [];
    for (const k of ['tick', 'hover', 'click', 'blockFound'] as const) (sound as any)[k] = (...a: unknown[]) => log.push([frames, k, a]);
    Object.assign(window, { __sound: { log, render: (ev: [number, string, unknown[]][], secs: number) => renderEvents(ev, secs) } });
    // the recorder drives time: every call advances the whole app by exactly dt seconds
    Object.assign(window, { __tick: tick, __app: { view, blockPos, select, closeDetail, setMetric, startPlay, stopPlay, setCut, openSearch, closeSearch, chain, events: EVENTS, sound } });
  } else {
    let prev = performance.now();
    // rAF timestamps can precede performance.now() at setup, so never step backwards
    const loop = (now: number) => { tick(Math.min(.05, Math.max(0, (now - prev) / 1000))); prev = now; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  const before = chain.n;
  try {
    const r = await backfill(chain, () => {});
    for (let h = before; h < chain.n; h++) view.writeBlock(h);
    if (chain.n > before) { view.syncCount(); drawSpark(); renderSubtitle(); if (view.follow && !view.revealing) view.goLive(1); }
    if (r.missing > 0) toast(`Showing blocks up to <b>#${fmtInt(chain.n - 1)}</b>; the saved snapshot is too old to fill the last ${fmtInt(r.missing)} live.`);
  } catch { /* offline: snapshot only */ }
  renderLive();

  liveFeed({
    block: b => {
      const grew = putBlock(chain, b);
      view.writeBlock(b.height);
      if (!grew) return;
      view.syncCount(); drawSpark(); renderSubtitle(); renderLive(); renderPending();
      view.celebrate(); sound.blockFound();
      if (view.follow) view.goLive(1.4);
      if (performance.now() > 8000) toast(`New block <b>#${fmtInt(b.height)}</b> joined the chain · ${fmtInt(b.tx_count)} transactions · ${esc(b.extras?.pool?.name ?? 'unknown miner')}`, () => select(b.height));
    },
    mempool: mp => { mempool = mp; view.setMempool(mp.nextFill, mp.vbPerSec / 250); renderPending(); },
    state: s => { liveState = s; renderLive(); },
  });
}

/** one step of the whole app */
let introAt = -1, clock = 0;
let frames = 0;
function tick(dt: number) {
  clock += dt; frames++;
  if (introAt >= 0 && clock >= introAt) { introAt = -1; if (!view.fly && view.follow) view.goLive(3.4); }
  if (clock - lastStep > .35) momentum = Math.max(0, momentum - dt * .8);
  view.frame(dt);
  tickChrome(); tickTimeline(dt); tickHover();
}

/* ============================== chrome ============================== */
function renderLive() {
  const tip = chain.n - 1, px = livePrice || chain.usd[tip];
  $('#live').className = 'live ' + (liveState === 'on' ? 'on' : liveState === 'off' ? 'off' : '');
  $('#live-text').textContent = innerWidth < 440 ? fmtUsd(px) : innerWidth < 600
    ? `#${fmtInt(tip)} · ${fmtUsd(px)}`
    : `${liveState === 'off' ? 'Offline' : 'Live'} · #${fmtInt(tip)} · ${ago(chain.time[tip])} · ${fmtUsd(px)}`;
}
function renderSubtitle() { $('#subtitle').textContent = `${fmtInt(chain.n)} blocks linked since 3 Jan 2009`; }
function renderPending() {
  const since = Math.max(0, Date.now() / 1000 - chain.time[chain.n - 1]) / 60;
  const waiting = mempool?.count ? `${fmtInt(mempool.count)} txs waiting` : 'Collecting transactions';
  view.pendingText(`<b>Next block</b><span>${waiting}</span><span>${Math.floor(since)} min since last block</span>`);
}
let hintGone = false;
function hideHint() { if (hintGone) return; hintGone = true; $('#hint').classList.add('gone'); }

/* full screen: the whole page, so the UI stays usable. Hidden where the browser can't do it (e.g. iPhone Safari). */
const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
const isFull = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
function toggleFullscreen() {
  if (isFull()) (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
  else (root.requestFullscreen ?? root.webkitRequestFullscreen)?.call(root)?.catch?.(() => {});
}
function initFullscreen() {
  const btn = $('#fullscreen');
  if (!(root.requestFullscreen || root.webkitRequestFullscreen)) { btn.hidden = true; return; }
  btn.addEventListener('click', toggleFullscreen);
  const sync = () => {
    btn.setAttribute('aria-pressed', String(isFull()));
    btn.setAttribute('aria-label', isFull() ? 'Exit full screen' : 'Enter full screen');
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
}

function initChrome() {
  initFullscreen();
  const snd = $('#sound');
  let wantSound = true;
  try { wantSound = localStorage.getItem('sound') !== 'off'; } catch { /* storage blocked */ }
  const show = (on: boolean) => { snd.setAttribute('aria-pressed', String(on)); snd.setAttribute('aria-label', on ? 'Turn sound off' : 'Turn sound on'); };
  show(wantSound);
  if (wantSound && !CAPTURE) {
    const unlock = (e: Event) => {
      if ((e.target as HTMLElement).closest?.('#sound')) return;          // the toggle handles itself
      removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true);
      if (!sound.on && snd.getAttribute('aria-pressed') === 'true') sound.start();
    };
    addEventListener('pointerdown', unlock, true); addEventListener('keydown', unlock, true);
  }
  snd.addEventListener('click', () => {
    const on = snd.getAttribute('aria-pressed') === 'true' ? (sound.stop(), false) : sound.start();
    show(on);
    try { localStorage.setItem('sound', on ? 'on' : 'off'); } catch { /* storage blocked */ }
  });
  $('#live').addEventListener('click', () => { closeDetail(); stopPlay(); setCut(chain.n); view.goLive(); });
  $('#zoom').addEventListener('click', () => {
    closeDetail(); hideHint();
    if (document.body.classList.contains('history')) { stopPlay(); setCut(chain.n); view.goLive(2.2); } else view.overview();
  });
  document.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button, .menu li')) sound.click(); });
}
let wasHistory = false;
function tickChrome() {
  const hist = view.far > .8;
  if (hist === wasHistory) return;
  wasHistory = hist;
  document.body.classList.toggle('history', hist);
  $('#bar').setAttribute('aria-hidden', String(!hist));
  $('#zoom-label').textContent = hist ? 'Back to live' : 'See all history';
  if (hist) drawSpark();
}

let setMetric: (m: Metric) => void = () => {};
function initColor() {
  const btn = $('#color-btn'), menu = $('#color-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  setMetric = (mm: Metric) => {
    view.setMetric(mm); drawSpark();
    menu.querySelectorAll('li').forEach(li => li.setAttribute('aria-selected', String((li as HTMLElement).dataset.m === mm)));
    $('#color-label').textContent = menu.querySelector(`[data-m="${mm}"] b`)!.textContent!;
    $('#color-swatch').className = 'swatch' + (mm === 'pool' ? ' pools' : '');
  };
  btn.addEventListener('click', () => { menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
  menu.querySelectorAll<HTMLElement>('li').forEach(li => li.addEventListener('click', () => { setMetric(li.dataset.m as Metric); close(); }));
  addEventListener('pointerdown', e => { if (!(e.target as HTMLElement).closest('.color')) close(); });
  menu.querySelector('[data-m="tx"]')!.setAttribute('aria-selected', 'true');
}

/* ============================== timeline ============================== */
let cut = -1;
let playing = false, playT = 0, playDur = 22;
const hToX = (h: number) => h / Math.max(1, chain.n - 1);
function drawSpark() {
  const cv = $('#spark') as HTMLCanvasElement, r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio);
  if (!r.width) return;
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const x = cv.getContext('2d')!; x.scale(dpr, dpr);
  const W = r.width, H = r.height, bins = Math.min(260, Math.floor(W / 3)), per = chain.n / bins;
  for (let b = 0; b < bins; b++) {
    let s = 0, k = 0;
    for (let h = Math.floor(b * per); h < Math.min(chain.n, (b + 1) * per); h += 5) { s += view.t[h]; k++; }
    const v = k ? s / k : 0, bw = W / bins, hgt = 3 + v * (H - 24);
    x.fillStyle = cut >= 0 && b * per > cut ? 'rgba(247,147,26,.12)' : `rgba(247,147,26,${.22 + v * .4})`;
    x.fillRect(b * bw + .5, H - 6 - hgt, Math.max(1, bw - 1.2), hgt);
  }
  // BTC price, log scale, as a bright line over the bars
  let maxUsd = 1; for (let h = 0; h < chain.n; h += 7) if (chain.usd[h] > maxUsd) maxUsd = chain.usd[h];
  const lp = (v: number) => Math.log10(Math.max(.05, v)), lo = lp(.05), hi = lp(maxUsd * 1.1);
  x.beginPath();
  let started = false;
  for (let px = 0; px <= W; px += 2) {
    const h = Math.min(chain.n - 1, Math.floor(px / W * (chain.n - 1))), v = chain.usd[h];
    if (v <= 0) continue;
    const y = H - 6 - (lp(v) - lo) / (hi - lo) * (H - 20);
    started ? x.lineTo(px, y) : x.moveTo(px, y); started = true;
  }
  x.strokeStyle = 'rgba(255,236,210,.85)'; x.lineWidth = 1.3; x.stroke();
  x.fillStyle = 'rgba(238,234,226,.32)'; x.font = '500 10px "Geist Mono", monospace';
  let last = 0, lastX = -1e9;
  for (let h = 0; h < chain.n; h += 2016) {
    const y = new Date(chain.time[h] * 1000).getUTCFullYear(), px = hToX(h) * W;
    if (y !== last && (y % 3 === 0 || y === 2009) && px - lastX > 42) { x.fillText(String(y), px + 3, 11); lastX = px; }
    last = y;
  }
  placeCursor();
}
function placeCursor() {
  const h = cut < 0 ? chain.n - 1 : cut, x = hToX(h), lbl = $('#cursor-label');
  $('#cursor').style.left = `${x * 100}%`;
  lbl.textContent = cut < 0 ? `Now · ${fmtUsd(livePrice || chain.usd[h])}` : `${fmtDate(chain.time[h])} · ${fmtUsd(chain.usd[h])}`;
  lbl.style.left = x > .85 ? 'auto' : x < .1 ? '0' : '50%';
  lbl.style.right = x > .85 ? '0' : 'auto';
  lbl.style.transform = x > .85 || x < .1 ? 'none' : 'translateX(-50%)';
}
function setCut(h: number) {
  cut = h >= chain.n - 1 ? -1 : Math.max(0, Math.round(h));
  view.setCut(cut < 0 ? 1e9 : cut);
  placeCursor(); drawSparkSoon();
}
let sparkQueued = false;
function drawSparkSoon() { if (sparkQueued) return; sparkQueued = true; requestAnimationFrame(() => { sparkQueued = false; drawSpark(); }); }
function initTimeline() {
  const rail = $('#rail'), marks = $('#marks');
  marks.innerHTML = EVENTS.map(e => `<div class="mark ${e.kind}" data-h="${e.h}" style="left:${hToX(e.h) * 100}%"><span>${esc(e.name)}</span></div>`).join('');
  marks.querySelectorAll<HTMLElement>('.mark').forEach(m => m.addEventListener('pointerdown', e => { e.stopPropagation(); select(+m.dataset.h!); }));
  const at = (e: PointerEvent) => { const r = rail.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (chain.n - 1); };
  let drag = false;
  rail.addEventListener('pointerdown', e => { drag = true; rail.setPointerCapture(e.pointerId); stopPlay(); closeDetail(); setCut(at(e)); });
  rail.addEventListener('pointermove', e => { if (drag) setCut(at(e)); });
  rail.addEventListener('pointerup', () => { drag = false; });
  $('#play').addEventListener('click', () => (playing ? stopPlay() : startPlay()));
  addEventListener('resize', drawSpark);
}
function tickTimeline(dt: number) {
  if (!playing) return;
  playT = Math.min(1, playT + dt / playDur);
  const e = playT < .5 ? 2 * playT * playT : 1 - (-2 * playT + 2) ** 2 / 2;
  setCut(e * (chain.n - 1));
  if (playT >= 1) stopPlay();
}
function startPlay(dur = 22) {
  playing = true; playT = 0; playDur = dur; closeDetail();
  if (view.far < .8) view.overview(1.6);
  $('#play').innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z"/></svg>';
  $('#play').setAttribute('aria-label', 'Pause');
}
function stopPlay() {
  if (!playing) return;
  playing = false;
  $('#play').innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg>';
  $('#play').setAttribute('aria-label', 'Replay the chain from 2009');
}

/* ============================== pointer ============================== */
let pend: { x: number; y: number } | null = null, lastHover = -1, mouse = true;
function initPointer() {
  const cv = $('#gl'), tip = $('#tip');
  let down = { x: 0, y: 0 };
  cv.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') pend = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('pointerleave', () => { pend = null; view.hover(-1); tip.hidden = true; lastHover = -1; });
  cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; mouse = e.pointerType === 'mouse'; if (!mouse) tip.hidden = true; });
  cv.addEventListener('pointerup', e => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const h = view.pick(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (h >= 0) select(h); else closeDetail();
  });
}
function tickHover() {
  if (!pend || !mouse) return;
  const p = pend; pend = null;
  const tip = $('#tip'), cv = $('#gl');
  const h = view.pick(p.x / innerWidth * 2 - 1, -(p.y / innerHeight) * 2 + 1);
  view.hover(h);
  if (h !== lastHover && h >= 0) sound.hover();
  lastHover = h;
  cv.style.cursor = h >= 0 ? 'pointer' : 'grab';
  if (h < 0) { tip.hidden = true; return; }
  const ev = eventAt(h);
  tip.hidden = false; tip.style.left = p.x + 'px'; tip.style.top = p.y + 'px';
  tip.innerHTML = `<b>#${fmtInt(h)}</b> <span>· ${fmtDate(chain.time[h])}</span><br>${fmtInt(chain.tx[h])} transactions <span>·</span> BTC ${fmtUsd(chain.usd[h])}${ev ? `<br><span style="color:${KIND_COLOR[ev.kind]}">${esc(ev.name)}</span>` : ''}`;
}

/* ============================== block card ============================== */
const ICON = {
  prev: '<svg viewBox="0 0 20 20"><path d="M12 5l-5 5 5 5"/></svg>',
  next: '<svg viewBox="0 0 20 20"><path d="M8 5l5 5-5 5"/></svg>',
  link: '<svg viewBox="0 0 20 20"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-.8.8M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l.8-.8"/></svg>',
  out: '<svg viewBox="0 0 20 20"><path d="M8 5H5v10h10v-3M11 4h5v5M16 4l-7 7"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="M5 10.5l3 3 7-7"/></svg>',
};
const shareUrl = (h: number) => `${location.origin}/b/${h}`;
/*
 * Stepping with momentum: quick presses (or a held arrow key) build speed. Each step then skips more
 * blocks and the camera pulls back, until at full speed you land on the whole history.
 */
let momentum = 0, lastStep = -1;
function step(dir: 1 | -1) {
  const gap = clock - lastStep;
  lastStep = clock;
  if (gap < .14) momentum = Math.min(1, momentum + .011);   // quick presses build speed
  else if (gap > .6) momentum *= .5;                        // a real pause bleeds it off
  if (momentum >= 1) { momentum = 0; closeDetail(); view.overview(1.6); return; }
  const skip = Math.max(1, Math.round(Math.exp(momentum * 9)));
  const from = selected >= 0 ? selected : chain.n - 1;
  select(Math.max(0, Math.min(chain.n - 1, from + dir * skip)), true, true);
}
let lastHash = 0;
function select(h: number, fly = true, stepping = false) {
  h = Math.max(0, Math.min(chain.n - 1, h));
  stopPlay(); hideHint();
  if (cut >= 0 && h > cut) setCut(chain.n);
  const prev = selected;
  selected = h;
  view.select(h);
  if (fly) { if (stepping || (prev >= 0 && prev !== h && Math.abs(h - prev) <= 3 && view.far < .3)) view.stepTo(h, stepping ? momentum : 0); else view.focusBlock(h); }
  if (momentum < .05) view.showTxCloud(h);
  if (clock - lastHash > .3) { lastHash = clock; history.replaceState(null, '', `#${h}`); }   // browsers rate-limit URL updates
  renderCard(h);
}
function closeDetail() {
  if (selected < 0) return;
  selected = -1; view.select(-1); $('#detail').hidden = true;
  history.replaceState(null, '', '/');
}
function renderCard(h: number) {
  const el = $('#detail'), c = chain, ev = eventAt(h);
  el.hidden = false;
  el.innerHTML = `
    <div class="d-head">
      <div>
        <div class="d-height"><small>#</small>${fmtInt(h)}</div>
        <div class="d-when">${fmtDate(c.time[h], true)} · ${ago(c.time[h])}</div>
      </div>
      <button class="x" id="d-close" aria-label="Close">×</button>
    </div>
    ${ev ? `<div class="d-event"><i style="background:${KIND_COLOR[ev.kind]}"></i><div><b>${esc(ev.name)}.</b> ${esc(ev.desc)}</div></div>` : ''}
    <div class="d-stats">
      <div><b>${fmtInt(c.tx[h])}</b><span>Transactions</span></div>
      <div><b>${fmtUsd(c.usd[h])}</b><span>BTC price</span></div>
      <div><b title="${esc(poolName(c.pool[h]))}"><i style="display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:1px;background:${poolColor(c.pool[h])}"></i>${esc(poolName(c.pool[h]))}</b><span>Miner</span></div>
    </div>
    <div class="d-foot">
      <button class="nav" id="d-prev" ${h === 0 ? 'disabled' : ''} aria-label="Previous block">${ICON.prev}</button>
      <button class="nav" id="d-next" ${h >= c.n - 1 ? 'disabled' : ''} aria-label="Next block">${ICON.next}</button>
      <span class="note">${fmtSize(c.size[h])} · ${fmtBtc(subsidy(h) + c.fee[h] / 1e8)} to miner</span>
      <button class="nav" id="d-copy" aria-label="Copy link to this block">${ICON.link}</button>
      <a class="nav" href="https://mempool.space/block/${h}" target="_blank" rel="noopener" aria-label="Open in mempool.space">${ICON.out}</a>
    </div>`;
  $('#d-close').onclick = closeDetail;
  $('#d-prev').onclick = () => step(-1);
  $('#d-next').onclick = () => step(1);
  $('#d-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(shareUrl(h)); $('#d-copy').innerHTML = ICON.check; setTimeout(() => ($('#d-copy') && ($('#d-copy').innerHTML = ICON.link)), 1500); } catch { toast(shareUrl(h)); }
  };
}

/* ============================== search ============================== */
type Sugg = { title: string; meta?: string; note?: string; go: () => void | Promise<void> };
function suggestions(q: string): Sugg[] {
  q = q.trim();
  const out: Sugg[] = [];
  if (!q) {
    out.push({ title: 'Latest block', meta: `#${fmtInt(chain.n - 1)}`, go: () => select(chain.n - 1) });
    EVENTS.filter(e => e.major).forEach(e => out.push({ title: e.name, meta: fmtDate(chain.time[e.h]), note: e.desc, go: () => select(e.h) }));
    return out;
  }
  const num = q.replace(/[#,\s]/g, '');
  if (/^\d{1,7}$/.test(num) && +num < chain.n) out.push({ title: `Block #${fmtInt(+num)}`, meta: fmtDate(chain.time[+num]), go: () => select(+num) });
  if (/^[0-9a-f]{64}$/i.test(q)) {
    const isBlock = q.startsWith('00000000');
    out.push({
      title: isBlock ? 'Find this block' : 'Find this transaction', meta: q.slice(0, 8) + '…', go: async () => {
        setSuggest([{ title: 'Looking it up…', go: () => {} }], true);
        try {
          const h = isBlock ? (await api.block(q)).height : (await api.tx(q)).status?.block_height;
          if (h == null) throw new Error('unconfirmed');
          closeSearch(); select(h);
          if (!isBlock) toast(`That transaction is in block <b>#${fmtInt(h)}</b>`);
        } catch { setSuggest([{ title: 'Not found, or not confirmed yet.', go: () => {} }], true); }
      },
    });
  }
  const lq = q.toLowerCase();
  EVENTS.filter(e => (e.name + ' ' + e.desc).toLowerCase().includes(lq)).forEach(e => out.push({ title: e.name, meta: fmtDate(chain.time[e.h]), note: e.desc, go: () => select(e.h) }));
  // dates: 2017, 2017-12, 2017-12-17, "17 Dec 2017", "Dec 17, 2017"
  const iso = /^\d{4}(-\d{2}){0,2}$/.test(q), words = /^(\d{1,2} [a-z]{3,9},? \d{4}|[a-z]{3,9} \d{1,2},? \d{4}|[a-z]{3,9} \d{4})$/i.test(q);
  if (iso || words) {
    const t = Date.parse(iso ? (q.length === 4 ? `${q}-01-01` : q.length === 7 ? `${q}-01` : q) + 'T00:00:00Z' : q + ' UTC');
    const h = isNaN(t) ? -1 : firstBlockOn(t / 1000);
    if (h >= 0) out.push({ title: `First block on ${fmtDate(t / 1000)}`, meta: `#${fmtInt(h)}`, go: () => select(h) });
  }
  if (!out.length) out.push({ title: 'Try a block number, a date, an event like "halving", or a transaction ID', go: () => {} });
  return out;
}
let current: Sugg[] = [], active = 0;
function setSuggest(list: Sugg[], msg = false) {
  current = list; active = 0;
  const ul = $('#suggest'); ul.hidden = false;
  ul.innerHTML = list.map((s, i) => `<li role="option" data-i="${i}" aria-selected="${i === 0 && !msg}" class="${msg ? 'msg' : ''}"><b>${esc(s.title)}</b><span>${esc(s.meta || '')}</span>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('');
  ul.querySelectorAll('li').forEach(li => li.addEventListener('mousedown', e => { e.preventDefault(); run(+(li as HTMLElement).dataset.i!); }));
}
function openSearch(q = '') { $('#search').classList.add('open'); const i = $('#q') as HTMLInputElement; i.value = q; i.focus(); setSuggest(suggestions(q)); }
function closeSearch() { $('#suggest').hidden = true; $('#search').classList.remove('open'); ($('#q') as HTMLInputElement).value = ''; ($('#q') as HTMLInputElement).blur(); }
function run(i: number) {
  const s = current[i]; if (!s) return;
  if (!(s.go() instanceof Promise)) closeSearch();
}
function initSearch() {
  const q = $('#q') as HTMLInputElement;
  $('#search-btn').addEventListener('click', () => ($('#search').classList.contains('open') ? closeSearch() : openSearch()));
  q.addEventListener('focus', () => setSuggest(suggestions(q.value)));
  q.addEventListener('input', () => setSuggest(suggestions(q.value)));
  q.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== q) { $('#suggest').hidden = true; if (!q.value) $('#search').classList.remove('open'); } }, 150));
  q.addEventListener('keydown', e => {
    const items = $('#suggest').querySelectorAll('li');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      items[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape') closeSearch();
  });
  $('#search').addEventListener('submit', e => { e.preventDefault(); run(active); });
}

/* ============================== keys & toast ============================== */
function initKeys() {
  addEventListener('keydown', e => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === '/') { e.preventDefault(); openSearch(); }
    if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleFullscreen(); }
    if (e.key === 'Escape') closeDetail();
    if (e.key === 'ArrowLeft' && selected >= 0) { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight' && selected >= 0) { e.preventDefault(); step(1); }
    if (e.key.toLowerCase() === 'l') { closeDetail(); view.goLive(); }
  });
}
let toastTimer = 0;
function toast(html: string, onClick?: () => void) {
  const t = $('#toast');
  t.innerHTML = html; t.hidden = false;
  t.onclick = () => { onClick?.(); t.hidden = true; };
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (t.hidden = true), 7000);
}

boot();
