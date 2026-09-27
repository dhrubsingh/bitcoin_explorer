import './style.css';
import { Chain, Mempool, Metric, ago, api, backfill, fmtBtc, fmtDate, fmtInt, fmtMin, liveFeed, loadChain, putBlock } from './data';
import { View, poolColor } from './view';
import { Sound } from './audio';
import { canRecord, recordClip } from './clip';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sound = new Sound();

const LANDMARKS = [
  { h: 0, name: 'Genesis block', desc: 'Satoshi mines the first block. Its coinbase carries the headline “Chancellor on brink of second bailout for banks”.' },
  { h: 170, name: 'First payment', desc: 'Satoshi sends 10 BTC to Hal Finney, the first person-to-person transaction.' },
  { h: 57043, name: 'Pizza Day', desc: 'Laszlo Hanyecz pays 10,000 BTC for two pizzas.' },
  { h: 210000, name: 'First halving', desc: 'The block reward drops from 50 to 25 BTC.' },
  { h: 420000, name: 'Second halving', desc: 'The block reward drops to 12.5 BTC.' },
  { h: 481824, name: 'SegWit', desc: 'Segregated Witness activates, letting blocks grow past the old 1 MB limit.' },
  { h: 630000, name: 'Third halving', desc: 'The block reward drops to 6.25 BTC.' },
  { h: 709632, name: 'Taproot', desc: 'Taproot activates: Schnorr signatures and more flexible, more private scripts.' },
  { h: 767430, name: 'First inscription', desc: 'The first Ordinals inscription. Data-heavy transactions start pushing blocks toward 4 MB.' },
  { h: 840000, name: 'Fourth halving', desc: 'The reward drops to 3.125 BTC. Runes launch in the same block and fees spike.' },
];
const landmarkAt = (h: number) => LANDMARKS.find(l => l.h === h);
const subsidy = (h: number) => 50 / Math.pow(2, Math.floor(h / 210000));
const fmtSize = (b: number) => (b >= 1e6 ? (b / 1e6).toFixed(2) + ' MB' : (b / 1e3).toFixed(1) + ' kB');
const poolName = (i: number) => chain.pools[i].replace(/ Pool$/i, '');

let chain: Chain, view: View;
let selected = -1;
let liveState: 'on' | 'off' | 'wait' = 'wait';
let mempool: Mempool | null = null;

/* ============================== boot ============================== */
async function boot() {
  const txt = $('#loader-text');
  try {
    chain = await loadChain(f => { txt.textContent = `Downloading the blockchain… ${Math.round(f * 100)}%`; });
  } catch (e) { txt.textContent = 'Could not load block data. Please refresh.'; console.error(e); return; }
  view = new View($('#gl') as HTMLCanvasElement, $('#labels'), chain);
  view.addLandmarks(LANDMARKS.filter(l => l.h !== 170));
  view.onUserMove = () => hideHint();
  view.onTxLand = () => sound.tick();
  $('#loader').classList.add('done');

  // /b/840000 share links (and older #840000 links) open straight onto a block
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
    setTimeout(() => { if (!view.fly && view.follow) view.goLive(3.4); }, 3600);
  }
  const loop = () => { view.frame(); tickChrome(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  initChrome(); initColor(); initTimeline(); initPointer(); initSearch(); initFinder(); initKeys();
  renderLive(); renderSubtitle(); renderPending();
  setInterval(() => { renderLive(); renderPending(); }, 1000);
  setTimeout(hideHint, 18000);

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

/* ============================== chrome ============================== */
function renderLive() {
  const tip = chain.n - 1;
  $('#live').className = 'live ' + (liveState === 'on' ? 'on' : liveState === 'off' ? 'off' : '');
  $('#live-text').textContent = innerWidth < 600 ? `#${fmtInt(tip)}` : `${liveState === 'off' ? 'Offline' : 'Live'} · #${fmtInt(tip)} · ${ago(chain.time[tip])}`;
}
function renderSubtitle() { $('#subtitle').textContent = `${fmtInt(chain.n)} blocks linked since 3 Jan 2009`; }
function renderPending() {
  const since = Math.max(0, Date.now() / 1000 - chain.time[chain.n - 1]) / 60;
  const waiting = mempool?.count ? `${fmtInt(mempool.count)} txs waiting` : 'Collecting transactions';
  view.pendingText(`<b>Next block</b><span>${waiting}</span><span>${Math.floor(since)} min since last block</span>`);
}
let hintGone = false;
function hideHint() { if (hintGone) return; hintGone = true; $('#hint').classList.add('gone'); }

function initChrome() {
  const snd = $('#sound');
  snd.addEventListener('click', () => {
    const on = sound.on ? (sound.stop(), false) : sound.start();
    snd.setAttribute('aria-pressed', String(on));
    snd.setAttribute('aria-label', on ? 'Turn sound off' : 'Turn sound on');
  });
  $('#live').addEventListener('click', () => { closeAll(); stopPlay(); setCut(chain.n); view.goLive(); });
  $('#zoom').addEventListener('click', () => {
    closeAll(); hideHint();
    if (document.body.classList.contains('history')) { stopPlay(); setCut(chain.n); view.goLive(2.2); } else view.overview();
  });
  document.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button, .cta, .menu li')) sound.click(); });
}
let wasHistory = false;
function tickChrome() {
  const hist = view.far > .8 && !document.body.classList.contains('journey');
  if (hist !== wasHistory) {
    wasHistory = hist;
    document.body.classList.toggle('history', hist);
    $('#bar').setAttribute('aria-hidden', String(!hist));
    if (hist) drawSpark();
  }
}
function closeAll() { if (selected >= 0) closeDetail(); $('#result').hidden = true; }

function initColor() {
  const btn = $('#color-btn'), menu = $('#color-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const set = (mm: Metric) => {
    view.setMetric(mm); drawSpark();
    menu.querySelectorAll('li').forEach(li => li.setAttribute('aria-selected', String((li as HTMLElement).dataset.m === mm)));
    $('#color-label').textContent = menu.querySelector(`[data-m="${mm}"] b`)!.textContent!;
    $('#color-swatch').className = 'swatch' + (mm === 'pool' ? ' pools' : '');
  };
  btn.addEventListener('click', () => { menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
  menu.querySelectorAll<HTMLElement>('li').forEach(li => li.addEventListener('click', () => { set(li.dataset.m as Metric); close(); }));
  addEventListener('pointerdown', e => { if (!(e.target as HTMLElement).closest('.color')) close(); });
  menu.querySelector('[data-m="tx"]')!.setAttribute('aria-selected', 'true');
}

/* ============================== find your block ============================== */
const MODES = {
  born: { q: 'What block were you <em>born</em> in?', sub: 'Every ~10 minutes since January 2009, a new block has joined the chain. Find the one from your birthday.', kicker: 'You were born in block', share: (h: string) => `I was born in Bitcoin block ${h}.` },
  first: { q: 'Where does your <em>bitcoin</em> story start?', sub: 'Pick the day you first bought, mined or received bitcoin.', kicker: 'Your bitcoin story starts at block', share: (h: string) => `My bitcoin story starts at block ${h}.` },
  any: { q: 'Pick <em>any</em> day in history.', sub: 'An anniversary, a wedding, the day something changed. See which block was being mined.', kicker: 'On that day the chain reached block', share: (h: string) => `This day is Bitcoin block ${h}.` },
};
type Mode = keyof typeof MODES;
let mode: Mode = 'born';
let result: { h: number; kicker: string } | null = null;
function lowerBoundTime(t: number) {
  let lo = 0, hi = chain.n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (chain.time[m] < t) lo = m + 1; else hi = m; }
  return lo;
}
function openFinder() {
  closeAll(); hideHint();
  $('#finder').hidden = false;
  setTimeout(() => ($('#finder-date') as HTMLInputElement).focus(), 50);
}
function closeFinder() { $('#finder').hidden = true; }
function initFinder() {
  $('#find').addEventListener('click', openFinder);
  $('#finder-close').addEventListener('click', closeFinder);
  $('#finder').addEventListener('pointerdown', e => { if (e.target === $('#finder')) closeFinder(); });
  document.querySelectorAll<HTMLButtonElement>('.modes button').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode as Mode;
    document.querySelectorAll('.modes button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('#finder-q').innerHTML = MODES[mode].q; $('#finder-sub').textContent = MODES[mode].sub;
  }));
  const date = $('#finder-date') as HTMLInputElement;
  date.max = new Date().toISOString().slice(0, 10);
  $('#finder-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!date.value) return;
    const t = Date.parse(date.value + 'T00:00:00Z') / 1000;
    closeFinder();
    let h: number, kicker = MODES[mode].kicker, sub = '';
    if (t < chain.time[0] - 86400) {
      h = 0; kicker = mode === 'born' ? "You're older than Bitcoin" : 'Before Bitcoin existed';
      sub = 'The chain began on 3 January 2009 with the genesis block.';
    } else if (t > chain.time[chain.n - 1]) {
      h = chain.n - 1; kicker = "That day's block hasn't been mined yet"; sub = 'Here is the newest block instead.';
    } else h = lowerBoundTime(t);
    journey(h, kicker, sub);
  });
  $('#result-close').addEventListener('click', () => { $('#result').hidden = true; view.select(-1); });
  $('#r-more').addEventListener('click', () => { if (result) { $('#result').hidden = true; select(result.h, false); } });
  $('#r-copy').addEventListener('click', async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(shareUrl(result.h)); $('#r-copy').textContent = 'Copied'; } catch { $('#r-copy').textContent = shareUrl(result.h); }
  });
  const clipBtn = $('#r-clip') as HTMLButtonElement;
  if (!canRecord()) clipBtn.hidden = true;
  clipBtn.addEventListener('click', async () => {
    if (!result) return;
    const r = result, bar = $('#r-progress'), fill = bar.firstElementChild as HTMLElement;
    clipBtn.disabled = true; clipBtn.textContent = 'Recording…'; bar.hidden = false;
    $('#result').style.opacity = '.35';
    try {
      const { blob, ext } = await recordClip(view, sound, r.h, {
        kicker: r.kicker, big: `#${fmtInt(r.h)}`, sub: `${fmtDate(chain.time[r.h])} · ${fmtInt(chain.tx[r.h])} transactions`, foot: location.host,
      }, 6, f => (fill.style.width = `${f * 100}%`));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `bitcoin-block-${r.h}.${ext}`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      clipBtn.textContent = 'Saved';
    } catch (err) { clipBtn.textContent = 'Recording failed'; console.error(err); }
    clipBtn.disabled = false; bar.hidden = true; fill.style.width = '0'; $('#result').style.opacity = '';
    setTimeout(() => (clipBtn.textContent = 'Save clip'), 2500);
  });
}
const shareUrl = (h: number) => `${location.origin}/b/${h}`;
function journey(h: number, kicker: string, sub: string) {
  stopPlay(); if (cut >= 0) setCut(chain.n);
  if (selected >= 0) closeDetail();
  document.body.classList.add('journey');
  view.select(-1);
  const counter = $('#counter'), num = $('#counter-num');
  counter.hidden = false;
  const from = Math.max(0, Math.min(chain.n - 1, view.nearest(view.controls.target.x, view.controls.target.z, chain.n - 1).i));
  const dur = view.journeyTo(h, () => arrive(h, kicker, sub));
  sound.whoosh(dur);
  const t0 = performance.now();
  const roll = () => {
    const k = Math.min(1, (performance.now() - t0) / (dur * 1000));
    const e = k < .5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
    num.textContent = `#${fmtInt(Math.round(from + (h - from) * e))}`;
    if (k < 1 && !counter.hidden) requestAnimationFrame(roll);
  };
  roll();
}
function arrive(h: number, kicker: string, sub: string) {
  $('#counter').hidden = true;
  document.body.classList.remove('journey');
  view.select(h); view.celebrateAt(h); sound.arrive();
  view.showTxCloud(h);
  history.replaceState(null, '', `#${h}`);
  result = { h, kicker };
  $('#r-kicker').textContent = kicker;
  $('#r-num').innerHTML = `<small>#</small>${fmtInt(h)}`;
  $('#r-date').textContent = sub || `Mined ${fmtDate(chain.time[h], true)}`;
  $('#r-facts').textContent = `${fmtInt(chain.tx[h])} transactions · mined by ${poolName(chain.pool[h])} · ${fmtBtc(subsidy(h))} reward`;
  const text = `${MODES[mode].share(`#${fmtInt(h)}`)} Find yours:`;
  ($('#r-share') as HTMLAnchorElement).href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl(h))}`;
  $('#r-copy').textContent = 'Copy link';
  $('#result').hidden = false;
}

/* ============================== timeline ============================== */
let cut = -1;
let playing = false, playT = 0;
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
    const v = k ? s / k : 0, bw = W / bins, hgt = 3 + v * (H - 22);
    x.fillStyle = cut >= 0 && b * per > cut ? 'rgba(247,147,26,.16)' : `rgba(247,147,26,${.35 + v * .55})`;
    x.fillRect(b * bw + .5, H - 6 - hgt, Math.max(1, bw - 1.2), hgt);
  }
  x.fillStyle = 'rgba(238,234,226,.3)'; x.font = '500 10px "Geist Mono", monospace';
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
  lbl.textContent = cut < 0 ? `Now · #${fmtInt(h)}` : `#${fmtInt(h)} · ${fmtDate(chain.time[h])}`;
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
  marks.innerHTML = LANDMARKS.filter(l => l.h < chain.n).map(l => `<div class="mark" data-h="${l.h}" style="left:${hToX(l.h) * 100}%"><span>${esc(l.name)}</span></div>`).join('');
  marks.querySelectorAll<HTMLElement>('.mark').forEach(m => m.addEventListener('pointerdown', e => { e.stopPropagation(); select(+m.dataset.h!); }));
  const at = (e: PointerEvent) => { const r = rail.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (chain.n - 1); };
  let drag = false;
  rail.addEventListener('pointerdown', e => { drag = true; rail.setPointerCapture(e.pointerId); stopPlay(); closeAll(); setCut(at(e)); });
  rail.addEventListener('pointermove', e => { if (drag) setCut(at(e)); });
  rail.addEventListener('pointerup', () => { drag = false; });
  $('#play').addEventListener('click', () => (playing ? stopPlay() : startPlay()));
  addEventListener('resize', drawSpark);
  let prev = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(.05, (now - prev) / 1000); prev = now;
    if (playing) {
      playT = Math.min(1, playT + dt / 22);
      const e = playT < .5 ? 2 * playT * playT : 1 - (-2 * playT + 2) ** 2 / 2;
      setCut(e * (chain.n - 1));
      if (playT >= 1) stopPlay();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function startPlay() {
  playing = true; playT = 0; closeAll();
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
function initPointer() {
  const cv = $('#gl'), tip = $('#tip');
  let down = { x: 0, y: 0 }, mouse = true, pend: { x: number; y: number } | null = null, last = -1;
  cv.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') pend = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('pointerleave', () => { pend = null; view.hover(-1); tip.hidden = true; last = -1; });
  cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; mouse = e.pointerType === 'mouse'; if (!mouse) tip.hidden = true; });
  cv.addEventListener('pointerup', e => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || document.body.classList.contains('journey')) return;
    const h = view.pick(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (h >= 0) { $('#result').hidden = true; select(h); } else if (selected >= 0) closeDetail();
  });
  const loop = () => {
    if (pend && mouse && !document.body.classList.contains('journey')) {
      const p = pend; pend = null;
      const h = view.pick(p.x / innerWidth * 2 - 1, -(p.y / innerHeight) * 2 + 1);
      view.hover(h);
      if (h !== last && h >= 0) sound.hover();
      last = h;
      cv.style.cursor = h >= 0 ? 'pointer' : 'grab';
      if (h >= 0) {
        const lm = landmarkAt(h);
        tip.hidden = false; tip.style.left = p.x + 'px'; tip.style.top = p.y + 'px';
        tip.innerHTML = `<b>#${fmtInt(h)}</b> <span>· ${fmtDate(chain.time[h])}</span><br>${fmtInt(chain.tx[h])} transactions${lm ? ` <span>·</span> <span style="color:var(--teal)">${esc(lm.name)}</span>` : ''}`;
      } else tip.hidden = true;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/* ============================== block detail ============================== */
const cache = new Map<number, { hash: string; info: any; txids: string[] }>();
let token = 0;
function select(h: number, fly = true) {
  h = Math.max(0, Math.min(chain.n - 1, h));
  selected = h; stopPlay(); hideHint();
  if (cut >= 0 && h > cut) setCut(chain.n);
  view.select(h); if (fly) view.focusBlock(h);
  history.replaceState(null, '', `#${h}`);
  renderDetail(h);
}
function closeDetail() {
  selected = -1; view.select(-1); $('#detail').hidden = true;
  history.replaceState(null, '', '/');
}
function renderDetail(h: number) {
  const el = $('#detail'), my = ++token, c = chain, lm = landmarkAt(h);
  const gap = h > 0 ? Math.max(0, (c.time[h] - c.time[h - 1]) / 60) : 0;
  el.hidden = false;
  el.innerHTML = `
    <div class="d-head">
      <div>
        <div class="d-kicker">Block</div>
        <div class="d-height"><small>#</small>${fmtInt(h)}</div>
        <div class="d-when">${fmtDate(c.time[h], true)} · ${ago(c.time[h])}</div>
      </div>
      <button class="x" id="d-close" aria-label="Close">×</button>
    </div>
    ${lm ? `<div class="badge"><b>${esc(lm.name)}.</b> ${esc(lm.desc)}</div>` : ''}
    <dl class="facts">
      <div><dt>Transactions</dt><dd>${fmtInt(c.tx[h])}</dd></div>
      <div><dt>Size</dt><dd>${fmtSize(c.size[h])}</dd></div>
      <div><dt>Fees</dt><dd>${fmtBtc(c.fee[h] / 1e8)}</dd></div>
      <div><dt>Miner reward</dt><dd>${fmtBtc(subsidy(h) + c.fee[h] / 1e8)}</dd></div>
      <div><dt>Mined by</dt><dd><i style="background:${poolColor(c.pool[h])}"></i>${esc(poolName(c.pool[h]))}</dd></div>
      <div><dt>After previous</dt><dd>${h > 0 ? fmtMin(gap) : '—'}</dd></div>
    </dl>
    <div><div class="sec-label">Fingerprint (block hash)</div><div class="hash" id="d-hash"><div class="skel" style="flex:1"></div></div></div>
    <div>
      <div class="sec-label">Transactions</div>
      <p class="muted" style="margin-bottom:8px">The dots above the block are its transactions${c.tx[h] > 2500 ? ' (first 2,500)' : ''}, brighter for higher fees.</p>
      <ul class="txs" id="d-txs"><li><div class="skel"></div></li><li><div class="skel"></div></li></ul>
    </div>
    <div class="d-nav">
      <button class="btn" id="d-prev" ${h === 0 ? 'disabled' : ''} aria-label="Previous block">←</button>
      <button class="btn" id="d-next" ${h >= c.n - 1 ? 'disabled' : ''} aria-label="Next block">→</button>
      <button class="btn" id="d-share">Copy link</button>
      <a class="btn primary" id="d-ext" href="https://mempool.space/block/${h}" target="_blank" rel="noopener">Explore ↗</a>
    </div>`;
  $('#d-close').onclick = closeDetail;
  $('#d-prev').onclick = () => select(h - 1);
  $('#d-next').onclick = () => select(h + 1);
  $('#d-share').onclick = async () => {
    try { await navigator.clipboard.writeText(shareUrl(h)); $('#d-share').textContent = 'Copied'; } catch { $('#d-share').textContent = shareUrl(h); }
  };
  view.showTxCloud(h);
  loadDetail(h).then(d => {
    if (my !== token) return;
    const z = d.hash.match(/^0*/)![0].length;
    $('#d-hash').innerHTML = `<code><span class="z">${d.hash.slice(0, z)}</span>${d.hash.slice(z)}</code><button class="copy" id="d-copy">Copy</button>`;
    $('#d-copy').onclick = () => navigator.clipboard.writeText(d.hash).then(() => ($('#d-copy').textContent = 'Copied'));
    ($('#d-ext') as HTMLAnchorElement).href = `https://mempool.space/block/${d.hash}`;
    view.showTxCloud(h, d.info?.extras?.feeRange);
    const txs = d.txids;
    $('#d-txs').innerHTML = txs.slice(0, 5).map((t, i) => `<li><a href="https://mempool.space/tx/${t}" target="_blank" rel="noopener"><span>${t.slice(0, 10)}…${t.slice(-8)}</span><span>${i === 0 ? 'new coins' : '#' + i}</span></a></li>`).join('') +
      (txs.length > 5 ? `<li><a href="https://mempool.space/block/${d.hash}" target="_blank" rel="noopener"><span>+ ${fmtInt(txs.length - 5)} more</span><span>↗</span></a></li>` : '');
  }).catch(() => {
    if (my !== token) return;
    $('#d-hash').innerHTML = '<span class="muted">Live details are unavailable right now.</span>';
    $('#d-txs').innerHTML = '';
  });
}
async function loadDetail(h: number) {
  if (cache.has(h)) return cache.get(h)!;
  const hash = (await api.hashAt(h)).trim();
  const [info, txids] = await Promise.all([api.block(hash).catch(() => null), api.txids(hash).catch(() => [] as string[])]);
  const d = { hash, info, txids };
  cache.set(h, d);
  return d;
}
const argmaxCache: Record<string, [number, number]> = {};
function argmax(name: 'tx' | 'fee') {
  const a = chain[name], k = argmaxCache[name];
  if (k && k[0] === chain.n) return k[1];
  let i = 0; for (let h = 1; h < chain.n; h++) if (a[h] > a[i]) i = h;
  argmaxCache[name] = [chain.n, i];
  return i;
}

/* ============================== search ============================== */
type Sugg = { title: string; meta?: string; note?: string; go: () => void | Promise<void> };
function suggestions(q: string): Sugg[] {
  q = q.trim();
  const out: Sugg[] = [];
  if (!q) {
    out.push({ title: 'Latest block', meta: `#${fmtInt(chain.n - 1)}`, go: () => select(chain.n - 1) });
    LANDMARKS.forEach(l => out.push({ title: l.name, meta: `#${fmtInt(l.h)}`, note: l.desc, go: () => select(l.h) }));
    out.push({ title: 'Most transactions ever', meta: `#${fmtInt(argmax('tx'))}`, go: () => select(argmax('tx')) });
    out.push({ title: 'Highest fees ever', meta: `#${fmtInt(argmax('fee'))}`, go: () => select(argmax('fee')) });
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
  if (!/^\d+$/.test(num) || num.length === 4) {
    const t = Date.parse(/^\d{4}$/.test(q) ? `${q}-01-01T00:00:00Z` : /^\d{4}-\d{2}(-\d{2})?$/.test(q) ? q + (q.length === 7 ? '-01' : '') + 'T00:00:00Z' : q + ' UTC');
    if (!isNaN(t) && t / 1000 >= chain.time[0] - 86400 && t / 1000 <= chain.time[chain.n - 1]) {
      const h = lowerBoundTime(t / 1000);
      out.push({ title: `First block on ${fmtDate(t / 1000)}`, meta: `#${fmtInt(h)}`, go: () => select(h) });
    }
  }
  const lq = q.toLowerCase();
  LANDMARKS.filter(l => (l.name + ' ' + l.desc).toLowerCase().includes(lq)).forEach(l => out.push({ title: l.name, meta: `#${fmtInt(l.h)}`, note: l.desc, go: () => select(l.h) }));
  if (!out.length) out.push({ title: 'Try a block number, a date like 2017-12-17, or a transaction ID', go: () => {} });
  return out;
}
let current: Sugg[] = [], active = 0;
function setSuggest(list: Sugg[], msg = false) {
  current = list; active = 0;
  const ul = $('#suggest'); ul.hidden = false;
  ul.innerHTML = list.map((s, i) => `<li role="option" data-i="${i}" aria-selected="${i === 0 && !msg}" class="${msg ? 'msg' : ''}"><b>${esc(s.title)}</b><span>${esc(s.meta || '')}</span>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('');
  ul.querySelectorAll('li').forEach(li => li.addEventListener('mousedown', e => { e.preventDefault(); run(+(li as HTMLElement).dataset.i!); }));
}
function openSearch() { $('#search').classList.add('open'); ($('#q') as HTMLInputElement).focus(); }
function closeSearch() { $('#suggest').hidden = true; $('#search').classList.remove('open'); ($('#q') as HTMLInputElement).value = ''; ($('#q') as HTMLInputElement).blur(); }
function run(i: number) {
  const s = current[i]; if (!s) return;
  closeAll();
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
    if ((e.target as HTMLElement).tagName === 'INPUT') { if (e.key === 'Escape') closeFinder(); return; }
    if (e.key === '/') { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape') { closeFinder(); closeAll(); }
    if (e.key.toLowerCase() === 'f' && $('#finder').hidden) { e.preventDefault(); openFinder(); }
    if (e.key === 'ArrowLeft' && selected > 0) select(selected - 1);
    if (e.key === 'ArrowRight' && selected >= 0 && selected < chain.n - 1) select(selected + 1);
    if (e.key.toLowerCase() === 'l') { closeAll(); view.goLive(); }
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
