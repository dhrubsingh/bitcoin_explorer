import './style.css';
import { Chain, METRICS, Metric, ago, api, backfill, fmtBtc, fmtDate, fmtInt, fmtMin, liveBlocks, loadChain, putBlock } from './data';
import { PER_RING, View, poolColor } from './view';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const LANDMARKS = [
  { h: 0, name: 'Genesis block', desc: 'Satoshi mines the first block. Its coinbase carries the headline “Chancellor on brink of second bailout for banks”.' },
  { h: 170, name: 'First person-to-person payment', desc: 'Satoshi sends 10 BTC to Hal Finney.' },
  { h: 57043, name: 'Bitcoin Pizza Day', desc: 'Laszlo Hanyecz pays 10,000 BTC for two pizzas.' },
  { h: 210000, name: 'First halving', desc: 'The block reward drops from 50 to 25 BTC.' },
  { h: 420000, name: 'Second halving', desc: 'The block reward drops to 12.5 BTC.' },
  { h: 481824, name: 'SegWit activates', desc: 'Segregated Witness lets blocks grow past the old 1 MB limit.' },
  { h: 630000, name: 'Third halving', desc: 'The block reward drops to 6.25 BTC.' },
  { h: 709632, name: 'Taproot activates', desc: 'Schnorr signatures and more flexible, more private scripts.' },
  { h: 767430, name: 'First Ordinals inscription', desc: 'Inscriptions start filling blocks with data, pushing sizes toward 4 MB.' },
  { h: 840000, name: 'Fourth halving', desc: 'The reward drops to 3.125 BTC. Runes launch in the same block and fees spike.' },
];
const landmarkAt = (h: number) => LANDMARKS.find(l => l.h === h);
const subsidy = (h: number) => 50 / Math.pow(2, Math.floor(h / 210000));
const fmtDiff = (d: number) => d >= 1e12 ? (d / 1e12).toFixed(2) + ' T' : d >= 1e9 ? (d / 1e9).toFixed(2) + ' G' : d >= 1e6 ? (d / 1e6).toFixed(2) + ' M' : d >= 1e3 ? (d / 1e3).toFixed(1) + ' K' : d.toFixed(0);
const fmtSize = (b: number) => b >= 1e6 ? (b / 1e6).toFixed(2) + ' MB' : (b / 1e3).toFixed(1) + ' kB';

let chain: Chain, view: View;
let selected = -1;
let lastPointer = { x: 0, y: 0, move: false };

/* ============================== boot ============================== */
async function boot() {
  const bar = $('#loader-bar'), txt = $('#loader-text');
  try {
    chain = await loadChain(f => { bar.style.width = `${f * 100}%`; txt.textContent = `Downloading the blockchain… ${Math.round(f * 100)}%`; });
  } catch (e) {
    txt.textContent = 'Could not load block data. Please refresh.'; console.error(e); return;
  }
  txt.textContent = `Laying out ${fmtInt(chain.n)} blocks…`;
  await new Promise(r => setTimeout(r, 30));
  view = new View($('#gl') as HTMLCanvasElement, $('#labels'), chain);
  $('#loader').classList.add('done');
  if (reduceMotion) { view.mat.uniforms.uReveal.value = 1e9; view.overview(0.01); } else { view.playReveal(); view.overview(4.6); }
  const loop = () => { view.frame(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  initMetrics(); renderLegend(); renderStats(); initTimeline(); initPointer(); initSearch(); initKeys();
  setInterval(renderLive, 15000);
  renderLive();
  const fromHash = parseInt(location.hash.slice(1));
  if (!isNaN(fromHash) && fromHash >= 0 && fromHash < chain.n) setTimeout(() => select(fromHash), reduceMotion ? 0 : 2600);

  // catch up to the live tip, then stream new blocks
  const before = chain.n;
  try {
    const r = await backfill(chain, () => {});
    for (let h = before; h < chain.n; h++) view.writeBlock(h);
    view.syncCount(); renderStats(); drawSpark(); renderLive();
    if (r.missing > 0) toast(`Showing blocks up to <b>#${fmtInt(chain.n - 1)}</b>. The saved snapshot is too old to fill the last ${fmtInt(r.missing)} blocks live.`);
  } catch { /* offline: snapshot only */ }
  liveBlocks(b => {
    const grew = putBlock(chain, b);
    view.writeBlock(b.height);
    if (grew) {
      view.syncCount(); renderStats(); drawSpark(); renderLive();
      if (performance.now() > 8000) toast(`New block <b>#${fmtInt(b.height)}</b> · ${fmtInt(b.tx_count)} txs · ${esc(b.extras?.pool?.name ?? 'Unknown miner')}`, () => select(b.height));
    }
  }, s => { liveState = s; renderLive(); });
}
let liveState: 'on' | 'off' | 'wait' = 'wait';

/* ============================== legend ============================== */
function initMetrics() {
  document.querySelectorAll<HTMLButtonElement>('#metrics button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#metrics button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
    view.setMetric(b.dataset.m as Metric); renderLegend(); drawSpark();
  }));
}
function renderLegend() {
  const m = view.metric, info = METRICS[m], el = $('#scale');
  if (m === 'pool') {
    const recent = new Map<number, number>();
    for (let h = Math.max(0, chain.n - PER_RING * 26); h < chain.n; h++) recent.set(chain.pool[h], (recent.get(chain.pool[h]) || 0) + 1);
    const tot = Math.min(chain.n, PER_RING * 26);
    const top = [...recent.entries()].filter(([i]) => i !== 0).sort((a, b) => b[1] - a[1]).slice(0, 11);
    el.innerHTML = `<ul class="pools">${top.map(([i, c]) => `<li><i style="background:${poolColor(i)}"></i>${esc(chain.pools[i].replace(/ ?Pool$/i, ''))} <span style="color:var(--text-3)">${Math.round(c / tot * 100)}%</span></li>`).join('')}<li><i style="background:${poolColor(0)}"></i>Unknown</li></ul><div class="scale-note">${info.note} Shares are for the past year.</div>`;
    return;
  }
  const [lo, hi] = view.legendRange();
  el.innerHTML = `<div class="grad"></div><div class="grad-labels"><span>${info.fmt(Math.max(0, lo))}</span><span>${info.fmt(hi)}+</span></div><div class="scale-note">${info.note}</div>`;
}
function renderStats() {
  let txs = 0, fees = 0;
  for (let h = 0; h < chain.n; h++) { txs += chain.tx[h]; fees += chain.fee[h]; }
  let supply = 0; for (let h = 0; h < chain.n; h++) supply += subsidy(h);
  $('#stats').innerHTML = [
    ['Blocks', fmtInt(chain.n)], ['Transactions', txs >= 1e9 ? (txs / 1e9).toFixed(2) + ' B' : (txs / 1e6).toFixed(0) + ' M'],
    ['BTC issued', (supply / 1e6).toFixed(2) + ' M'], ['Fees paid', fmtInt(fees / 1e8) + ' BTC'],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}
function renderLive() {
  const el = $('#live'), t = $('#live-text'), tip = chain.n - 1;
  el.className = 'live ' + (liveState === 'on' ? 'on' : liveState === 'off' ? 'off' : '');
  t.textContent = `${liveState === 'on' ? 'Live' : liveState === 'off' ? 'Offline' : 'Syncing'} · #${fmtInt(tip)} · ${ago(chain.time[tip])}`;
}

/* ============================== timeline ============================== */
let cut = -1; // -1 = show everything
let playing = false, playT = 0;
function hToX(h: number) { return h / Math.max(1, chain.n - 1); }
function drawSpark() {
  const cv = $('#spark') as HTMLCanvasElement, r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const x = cv.getContext('2d')!; x.scale(dpr, dpr);
  const rings = Math.ceil(chain.n / PER_RING), W = r.width, H = r.height;
  const grad = x.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, 'rgba(140,58,6,.5)'); grad.addColorStop(.6, 'rgba(247,147,26,.85)'); grad.addColorStop(1, 'rgba(255,220,160,1)');
  x.fillStyle = grad;
  for (let e = 0; e < rings; e++) {
    let s = 0, k = 0;
    for (let h = e * PER_RING; h < Math.min(chain.n, (e + 1) * PER_RING); h += 3) { s += view.t[h]; k++; }
    const v = k ? s / k : 0, bw = W / rings;
    x.globalAlpha = cut >= 0 && e * PER_RING > cut ? .25 : 1;
    x.fillRect(e * bw, H - 8 - v * (H - 18), Math.max(1, bw - .6), v * (H - 18) + 2);
  }
  x.globalAlpha = 1;
  x.fillStyle = 'rgba(237,233,225,.35)'; x.font = '500 10px "Geist Mono", monospace';
  let lastYear = 0;
  for (let h = 0; h < chain.n; h += PER_RING) {
    const y = new Date(chain.time[h] * 1000).getUTCFullYear();
    if (y !== lastYear && y % 2 === 1) { x.fillText(String(y), hToX(h) * W + 3, 12); lastYear = y; }
    if (y !== lastYear) lastYear = y;
  }
  placeCursor();
}
function placeCursor() {
  const h = cut < 0 ? chain.n - 1 : cut;
  $('#cursor').style.left = `${hToX(h) * 100}%`;
  const lbl = $('#cursor-label'), x = hToX(h);
  lbl.style.transform = x > .88 ? 'translateX(-100%)' : x < .08 ? 'translateX(0)' : 'translateX(-50%)';
  lbl.style.left = x > .88 ? '100%' : x < .08 ? '0' : '50%';
  $('#cursor-label').textContent = cut < 0 ? `Now · #${fmtInt(h)}` : `#${fmtInt(h)} · ${fmtDate(chain.time[h])}`;
}
function setCut(h: number) {
  cut = h >= chain.n - 1 ? -1 : Math.max(0, Math.round(h));
  view.mat.uniforms.uCut.value = cut < 0 ? 1e9 : cut;
  placeCursor(); drawSparkThrottled();
}
let sparkPending = false;
function drawSparkThrottled() { if (sparkPending) return; sparkPending = true; requestAnimationFrame(() => { sparkPending = false; drawSpark(); }); }
function initTimeline() {
  const track = $('#track'), marks = $('#marks');
  marks.innerHTML = LANDMARKS.filter(l => l.h < chain.n).map(l => `<div class="mark" data-h="${l.h}" style="left:${hToX(l.h) * 100}%"><span>${esc(l.name)}</span></div>`).join('');
  marks.querySelectorAll<HTMLElement>('.mark').forEach(m => m.addEventListener('pointerdown', e => { e.stopPropagation(); select(+m.dataset.h!); }));
  const at = (e: PointerEvent) => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (chain.n - 1); };
  let drag = false;
  track.addEventListener('pointerdown', e => { drag = true; track.setPointerCapture(e.pointerId); stopPlay(); setCut(at(e)); });
  track.addEventListener('pointermove', e => { if (drag) setCut(at(e)); });
  track.addEventListener('pointerup', () => { drag = false; });
  track.addEventListener('dblclick', () => setCut(chain.n));
  $('#play').addEventListener('click', () => (playing ? stopPlay() : startPlay()));
  addEventListener('resize', drawSpark);
  drawSpark();
  const tick = (now: number) => {
    if (playing) {
      playT += 1 / 60 / 26;
      const k = Math.min(1, playT), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      setCut(e * (chain.n - 1));
      if (k >= 1) stopPlay();
    }
    void now; requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function startPlay() {
  playing = true; playT = cut < 0 ? 0 : cut / (chain.n - 1);
  $('#play').innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z"/></svg>';
  $('#play').setAttribute('aria-label', 'Pause');
  if (selected >= 0) closeDetail();
  view.overview(2);
}
function stopPlay() {
  playing = false;
  $('#play').innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg>';
  $('#play').setAttribute('aria-label', 'Replay history from 2009');
}

/* ============================== pointer ============================== */
function initPointer() {
  const cv = $('#gl'), tip = $('#tip');
  let down = { x: 0, y: 0 };
  cv.addEventListener('pointermove', e => { lastPointer = { x: e.clientX, y: e.clientY, move: true }; });
  cv.addEventListener('pointerleave', () => { lastPointer.move = false; view.hover(-1); tip.hidden = true; });
  cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  cv.addEventListener('pointerup', e => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const h = view.pick(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (h >= 0) select(h); else if (selected >= 0) closeDetail();
  });
  let isMouse = true;
  cv.addEventListener('pointerdown', e => { isMouse = e.pointerType === 'mouse'; if (!isMouse) tip.hidden = true; });
  const hoverLoop = () => {
    if (lastPointer.move && isMouse) {
      lastPointer.move = false;
      const h = view.pick(lastPointer.x / innerWidth * 2 - 1, -(lastPointer.y / innerHeight) * 2 + 1);
      view.hover(h);
      cv.style.cursor = h >= 0 ? 'pointer' : 'grab';
      if (h >= 0) {
        tip.hidden = false;
        tip.style.left = lastPointer.x + 'px'; tip.style.top = lastPointer.y + 'px';
        const lm = landmarkAt(h);
        tip.innerHTML = `<b>#${fmtInt(h)}</b> <span>· ${fmtDate(chain.time[h])}</span><br>${fmtInt(chain.tx[h])} txs <span>·</span> ${fmtBtc(chain.fee[h] / 1e8)} fees <span>·</span> ${esc(chain.pools[chain.pool[h]])}${lm ? `<br><span style="color:var(--teal)">${esc(lm.name)}</span>` : ''}`;
      } else tip.hidden = true;
    }
    requestAnimationFrame(hoverLoop);
  };
  requestAnimationFrame(hoverLoop);
}

/* ============================== detail panel ============================== */
const cache = new Map<number, { hash: string; info: any; txids?: string[] }>();
let token = 0;
function select(h: number, fly = true) {
  h = Math.max(0, Math.min(chain.n - 1, h));
  selected = h; stopPlay();
  if (cut >= 0 && h > cut) setCut(chain.n);
  view.select(h, fly);
  history.replaceState(null, '', `#${h}`);
  renderDetail(h);
}
function closeDetail() {
  selected = -1; view.select(-1); $('#detail').hidden = true;
  history.replaceState(null, '', location.pathname);
}
function renderDetail(h: number) {
  const el = $('#detail'), my = ++token, c = chain;
  const lm = landmarkAt(h), interval = h > 0 ? (c.time[h] - c.time[h - 1]) / 60 : 0;
  const busiest = h === argmax(c.tx), richest = h === argmax(c.fee);
  el.hidden = false;
  el.innerHTML = `
    <div class="d-head">
      <div>
        <div class="label">Block</div>
        <div class="d-height"><small>#</small>${fmtInt(h)}</div>
        <div class="d-when">${fmtDate(c.time[h], true)} · ${ago(c.time[h])}</div>
      </div>
      <button class="x" id="d-close" aria-label="Close">×</button>
    </div>
    ${lm ? `<div class="badge"><span>★</span><span><b style="font-weight:600">${esc(lm.name)}.</b> ${esc(lm.desc)}</span></div>` : ''}
    ${busiest ? `<div class="badge">The most transactions of any block ever.</div>` : ''}
    ${richest ? `<div class="badge">The highest total fees of any block ever.</div>` : ''}
    <dl class="grid">
      <div><dt>Transactions</dt><dd>${fmtInt(c.tx[h])}</dd></div>
      <div><dt>Size</dt><dd>${fmtSize(c.size[h])}</dd></div>
      <div><dt>Fees</dt><dd>${fmtBtc(c.fee[h] / 1e8)}</dd></div>
      <div><dt>Miner reward</dt><dd>${fmtBtc(subsidy(h) + c.fee[h] / 1e8)}</dd></div>
      <div><dt>Mined by</dt><dd class="pool"><i style="background:${poolColor(c.pool[h])}"></i>${esc(c.pools[c.pool[h]])}</dd></div>
      <div><dt>After previous</dt><dd>${h > 0 ? fmtMin(Math.max(0, interval)) : '—'}</dd></div>
      <div><dt>Median fee</dt><dd id="d-median"><div class="skel" style="width:60%"></div></dd></div>
      <div><dt>Difficulty</dt><dd>${fmtDiff(c.epochDifficulty[Math.floor(h / PER_RING)] ?? c.epochDifficulty[c.epochDifficulty.length - 1])}</dd></div>
    </dl>
    <div class="fees-bar" id="d-fees"></div>
    <div><div class="label" style="margin-bottom:8px">Block hash</div><div class="hash" id="d-hash"><div class="skel" style="flex:1"></div></div></div>
    <div>
      <div class="label" style="margin-bottom:8px">Transactions</div>
      <p class="muted" style="margin:0 0 8px">Each glowing dot above the block is a transaction${c.tx[h] > 3000 ? ' (first 3,000 shown)' : ''}, coloured by fee rate.</p>
      <ul class="txs" id="d-txs"><li><div class="skel"></div></li><li><div class="skel"></div></li><li><div class="skel"></div></li></ul>
    </div>
    <div class="d-actions">
      <button class="btn" id="d-prev" ${h === 0 ? 'disabled' : ''}>← Prev</button>
      <button class="btn" id="d-next" ${h >= c.n - 1 ? 'disabled' : ''}>Next →</button>
      <button class="btn" id="d-share">Copy link</button>
      <a class="btn primary" id="d-ext" href="https://mempool.space/block/${h}" target="_blank" rel="noopener">mempool.space ↗</a>
    </div>`;
  $('#d-close').onclick = closeDetail;
  $('#d-prev').onclick = () => select(h - 1);
  $('#d-next').onclick = () => select(h + 1);
  $('#d-share').onclick = async () => {
    const url = `${location.origin}${location.pathname}#${h}`;
    try { await navigator.clipboard.writeText(url); $('#d-share').textContent = 'Link copied'; } catch { prompt('Copy this link', url); }
  };
  view.showTxCloud(h);
  loadDetail(h).then(d => {
    if (my !== token || !d) return;
    const info = d.info?.extras;
    const hashEl = $('#d-hash');
    const z = d.hash.match(/^0*/)![0].length;
    hashEl.innerHTML = `<code><span class="z">${d.hash.slice(0, z)}</span>${d.hash.slice(z)}</code><button class="copy" id="d-copy">Copy</button>`;
    $('#d-copy').onclick = () => navigator.clipboard.writeText(d.hash).then(() => ($('#d-copy').textContent = 'Copied'));
    ($('#d-ext') as HTMLAnchorElement).href = `https://mempool.space/block/${d.hash}`;
    $('#d-median').textContent = info?.medianFee != null ? `${info.medianFee < 10 ? info.medianFee.toFixed(1) : Math.round(info.medianFee)} sat/vB` : '—';
    const fr: number[] | undefined = info?.feeRange;
    if (fr && fr.length > 1 && c.tx[h] > 1) {
      const colors = ['#5A2A06', '#8C3A06', '#C45F0A', '#F7931A', '#FFB547', '#FFD89A', '#FFF1D6'];
      $('#d-fees').innerHTML = `<div class="label">Fee rates paid (sat/vB)</div><div class="bar">${fr.slice(0, 7).map((_, i) => `<i style="background:${colors[i]}"></i>`).join('')}</div><div class="ticks"><span>${Math.round(fr[0])} min</span><span>${Math.round(fr[Math.floor(fr.length / 2)])} median</span><span>${fmtInt(fr[fr.length - 1])} max</span></div>`;
    }
    view.showTxCloud(h, fr);
    const txs = d.txids || [];
    $('#d-txs').innerHTML = txs.slice(0, 6).map((t, i) => `<li><a href="https://mempool.space/tx/${t}" target="_blank" rel="noopener"><span>${t.slice(0, 10)}…${t.slice(-8)}</span><span>${i === 0 ? 'coinbase' : '#' + i}</span></a></li>`).join('') +
      (txs.length > 6 ? `<li><a href="https://mempool.space/block/${d.hash}" target="_blank" rel="noopener"><span>+ ${fmtInt(txs.length - 6)} more</span><span>↗</span></a></li>` : '');
  }).catch(() => {
    if (my !== token) return;
    $('#d-hash').innerHTML = '<span class="muted">Live details unavailable right now.</span>';
    $('#d-median').textContent = '—'; $('#d-txs').innerHTML = '';
  });
}
async function loadDetail(h: number) {
  if (cache.has(h)) return cache.get(h)!;
  const hash = (await api.hashAt(h)).trim();
  const [info, txids] = await Promise.all([api.block(hash).catch(() => null), api.txids(hash).catch(() => [])]);
  const d = { hash, info, txids };
  cache.set(h, d);
  return d;
}
const argmaxCache = new Map<any, { n: number; i: number }>();
function argmax(a: ArrayLike<number>) {
  const k = argmaxCache.get(a);
  if (k && k.n === chain.n) return k.i;
  let i = 0; for (let h = 1; h < chain.n; h++) if (a[h] > a[i]) i = h;
  argmaxCache.set(a, { n: chain.n, i });
  return i;
}

/* ============================== search ============================== */
type Sugg = { title: string; meta?: string; note?: string; go: () => void | Promise<void> };
function lowerBoundTime(t: number) {
  let lo = 0, hi = chain.n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (chain.time[m] < t) lo = m + 1; else hi = m; }
  return lo;
}
function suggestions(q: string): Sugg[] {
  q = q.trim();
  const out: Sugg[] = [];
  if (!q) {
    LANDMARKS.forEach(l => out.push({ title: l.name, meta: `#${fmtInt(l.h)}`, note: l.desc, go: () => select(l.h) }));
    out.push({ title: 'Busiest block ever', meta: `#${fmtInt(argmax(chain.tx))}`, go: () => select(argmax(chain.tx)) });
    out.push({ title: 'Highest fees ever', meta: `#${fmtInt(argmax(chain.fee))}`, go: () => select(argmax(chain.fee)) });
    out.push({ title: 'Latest block', meta: `#${fmtInt(chain.n - 1)}`, go: () => select(chain.n - 1) });
    return out;
  }
  const num = q.replace(/[#,\s]/g, '');
  if (/^\d{1,7}$/.test(num) && +num < chain.n) out.push({ title: `Block #${fmtInt(+num)}`, meta: fmtDate(chain.time[+num]), go: () => select(+num) });
  if (/^[0-9a-f]{64}$/i.test(q)) {
    const isBlock = q.startsWith('00000000');
    out.push({
      title: isBlock ? 'Find this block hash' : 'Find this transaction', meta: q.slice(0, 8) + '…', go: async () => {
        setSuggest([{ title: 'Looking it up…', go: () => {} }], true);
        try {
          const h = isBlock ? (await api.block(q)).height : (await api.tx(q)).status?.block_height;
          if (h == null) throw new Error('unconfirmed');
          select(h); hideSuggest();
          if (!isBlock) toast(`Transaction ${q.slice(0, 10)}… is in block <b>#${fmtInt(h)}</b>`);
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
  LANDMARKS.filter(l => l.name.toLowerCase().includes(lq) || l.desc.toLowerCase().includes(lq)).forEach(l => out.push({ title: l.name, meta: `#${fmtInt(l.h)}`, note: l.desc, go: () => select(l.h) }));
  if (!out.length) out.push({ title: 'Try a block height, a date like 2017-12-17, a block hash or a transaction ID', go: () => {} });
  return out;
}
let current: Sugg[] = [], active = 0;
function setSuggest(list: Sugg[], msg = false) {
  current = list; active = 0;
  const ul = $('#suggest');
  ul.hidden = false;
  ul.innerHTML = list.map((s, i) => `<li role="option" data-i="${i}" aria-selected="${i === 0 && !msg}" class="${msg ? 'msg' : ''}"><b>${esc(s.title)}</b><span>${esc(s.meta || '')}</span>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('');
  ul.querySelectorAll('li').forEach(li => li.addEventListener('mousedown', e => { e.preventDefault(); run(+(li as HTMLElement).dataset.i!); }));
}
function hideSuggest() { $('#suggest').hidden = true; }
function run(i: number) {
  const s = current[i]; if (!s) return;
  const r = s.go();
  if (!(r instanceof Promise)) { hideSuggest(); ($('#q') as HTMLInputElement).blur(); }
}
function initSearch() {
  const q = $('#q') as HTMLInputElement;
  q.addEventListener('focus', () => setSuggest(suggestions(q.value)));
  q.addEventListener('input', () => setSuggest(suggestions(q.value)));
  q.addEventListener('blur', () => setTimeout(hideSuggest, 120));
  q.addEventListener('keydown', e => {
    const items = $('#suggest').querySelectorAll('li');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      items[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape') { q.blur(); }
  });
  $('#search').addEventListener('submit', e => { e.preventDefault(); run(active); });
}

/* ============================== keys & toast ============================== */
function initKeys() {
  addEventListener('keydown', e => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT';
    if (e.key === '/' && !typing) { e.preventDefault(); ($('#q') as HTMLInputElement).focus(); }
    if (typing) return;
    if (e.key === 'Escape' && selected >= 0) closeDetail();
    if (e.key === 'ArrowLeft' && selected > 0) select(selected - 1);
    if (e.key === 'ArrowRight' && selected >= 0 && selected < chain.n - 1) select(selected + 1);
    if (e.key === ' ' && !typing) { e.preventDefault(); playing ? stopPlay() : startPlay(); }
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
