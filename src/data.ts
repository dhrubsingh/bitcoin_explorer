/** Every block ever mined, held as struct-of-arrays so a million entries stay cheap. */
export interface Chain {
  n: number;
  cap: number;
  time: Float64Array;     // unix seconds
  tx: Uint32Array;
  size: Uint32Array;      // bytes
  fee: Float64Array;      // sats
  pool: Uint8Array;       // index into pools
  pools: string[];
  epochDifficulty: number[];
}

export const API = 'https://mempool.space/api';
const EXTRA = 40000; // room for ~9 months of live growth without reallocating

const poolKey = (s?: string) => (s || 'unknown').toLowerCase().replace(/pool|mining|\.com|\.org/g, '').replace(/[^a-z0-9]/g, '') || 'unknown';

async function fetchWithProgress(url: string, onProgress: (f: number) => void) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`Could not load ${url} (${r.status})`);
  const total = +(r.headers.get('content-length') || 0);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  // some servers transparently decode .gz; only inflate if the gzip magic bytes are still there
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer as ArrayBuffer;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function loadChain(onProgress: (f: number) => void): Promise<Chain> {
  const meta = await (await fetch('/data/meta.json', { cache: 'no-cache' })).json();
  const [base, recent] = await Promise.all([
    fetchWithProgress(`/data/base.bin.gz?n=${meta.baseCount}`, onProgress).then(gunzip),
    fetch(`/data/recent.bin.gz?n=${meta.count}`).then(r => r.arrayBuffer()).then(b => gunzip(new Uint8Array(b))),
  ]);
  const n: number = meta.count, cap = n + EXTRA;
  const c: Chain = {
    n, cap, time: new Float64Array(cap), tx: new Uint32Array(cap), size: new Uint32Array(cap),
    fee: new Float64Array(cap), pool: new Uint8Array(cap), pools: meta.pools, epochDifficulty: meta.epochDifficulty,
  };
  const read = (buf: ArrayBuffer, from: number) => {
    const k = buf.byteLength / 13;
    let o = 0;
    const td = new Int32Array(buf, o, k); o += k * 4;
    const t16 = new Uint16Array(buf, o, k); o += k * 2;
    const s16 = new Uint16Array(buf, o, k); o += k * 2;
    const fk = new Uint32Array(buf, o, k); o += k * 4;
    const p8 = new Uint8Array(buf, o, k);
    let acc = 0;
    for (let i = 0; i < k; i++) {
      const h = from + i;
      acc += td[i]; c.time[h] = acc; c.tx[h] = t16[i]; c.size[h] = s16[i] * 100; c.fee[h] = fk[i] * 1000; c.pool[h] = p8[i];
    }
    return k;
  };
  const nb = read(base, 0);
  read(recent, nb);
  return c;
}

export function poolIndex(c: Chain, name?: string) {
  const k = poolKey(name);
  if (k === 'unknown') return 0;
  let i = c.pools.findIndex(p => poolKey(p) === k);
  if (i < 0 && c.pools.length < 255) { c.pools.push(name!); i = c.pools.length - 1; }
  return Math.max(0, i);
}

/** mempool.space block summary → our arrays. Returns true if it extended the chain. */
export function putBlock(c: Chain, b: any) {
  const h = b.height;
  if (h >= c.cap) return false;
  c.time[h] = b.timestamp; c.tx[h] = b.tx_count; c.size[h] = b.size;
  c.fee[h] = b.extras?.totalFees ?? 0; c.pool[h] = poolIndex(c, b.extras?.pool?.name);
  if (h >= c.n) { c.n = h + 1; return true; }
  return false;
}

async function getJSON(url: string, tries = 3): Promise<any> {
  for (let a = 0; a < tries; a++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue; }
      if (!r.ok) throw new Error(String(r.status));
      const ct = r.headers.get('content-type') || '';
      return ct.includes('json') ? r.json() : r.text();
    } catch (e) { if (a === tries - 1) throw e; await new Promise(s => setTimeout(s, 800 * (a + 1))); }
  }
}
export const api = {
  tipHeight: async () => +(await getJSON(`${API}/blocks/tip/height`)),
  blocksEndingAt: (h: number) => getJSON(`${API}/v1/blocks/${h}`),
  hashAt: (h: number) => getJSON(`${API}/block-height/${h}`) as Promise<string>,
  block: (hash: string) => getJSON(`${API}/v1/block/${hash}`),
  txids: (hash: string) => getJSON(`${API}/block/${hash}/txids`) as Promise<string[]>,
  tx: (txid: string) => getJSON(`${API}/tx/${txid}`),
};

/** Fill the gap between the snapshot and the current tip (newest pages first). */
export async function backfill(c: Chain, onBlocks: () => void, maxGap = 4000) {
  const tip = await api.tipHeight();
  if (tip < c.n) return { tip, missing: 0 };
  const from = Math.max(c.n, tip - maxGap + 1);
  const tops: number[] = [];
  for (let top = tip; top >= from; top -= 15) tops.push(top);
  let i = 0;
  const worker = async () => {
    while (i < tops.length) {
      const top = tops[i++];
      try { for (const b of await api.blocksEndingAt(top)) if (b.height >= from) putBlock(c, b); } catch { /* skip page */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // only extend through a contiguous run; a snapshot older than maxGap stops at its own tip
  let n = c.n; while (n <= tip && c.time[n] > 0) n++;
  c.n = n;
  onBlocks();
  return { tip, missing: tip + 1 - c.n };
}

/** Live new-block feed from mempool.space, with reconnects. */
export function liveBlocks(onBlock: (b: any) => void, onState: (s: 'on' | 'off') => void) {
  let ws: WebSocket | null = null, retry = 1000;
  const open = () => {
    ws = new WebSocket('wss://mempool.space/api/v1/ws');
    ws.onopen = () => { retry = 1000; ws!.send(JSON.stringify({ action: 'want', data: ['blocks'] })); onState('on'); };
    ws.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (m.block) onBlock(m.block);
        if (Array.isArray(m.blocks)) m.blocks.forEach(onBlock);
      } catch { /* ignore */ }
    };
    ws.onclose = () => { onState('off'); setTimeout(open, retry); retry = Math.min(30000, retry * 2); };
    ws.onerror = () => ws?.close();
  };
  open();
}

/* ---------- metrics ---------- */
export type Metric = 'tx' | 'fees' | 'size' | 'interval' | 'pool';
export const METRICS: Record<Metric, { label: string; unit: string; fmt: (v: number) => string; note: string }> = {
  tx: { label: 'Transactions', unit: 'txs', fmt: v => fmtInt(v), note: 'Transactions per block. Log scale.' },
  fees: { label: 'Fees', unit: 'BTC', fmt: v => fmtBtc(v), note: 'Total fees paid to the miner. Log scale.' },
  size: { label: 'Size', unit: 'MB', fmt: v => v.toFixed(v < 1 ? 2 : 1) + ' MB', note: 'Block size on disk. SegWit (2017) lifted the old 1 MB cap.' },
  interval: { label: 'Block time', unit: 'min', fmt: v => fmtMin(v), note: 'Minutes since the previous block. The target is 10.' },
  pool: { label: 'Miners', unit: '', fmt: () => '', note: 'Who mined each block. Height shows transactions.' },
};
export function metricValue(c: Chain, m: Metric, h: number) {
  switch (m) {
    case 'tx': case 'pool': return c.tx[h];
    case 'fees': return c.fee[h] / 1e8;
    case 'size': return c.size[h] / 1e6;
    case 'interval': return h === 0 ? 10 : Math.max(0, (c.time[h] - c.time[h - 1]) / 60);
  }
}

/* ---------- formatting ---------- */
export const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');
export const fmtBtc = (v: number) => (v === 0 ? '0 BTC' : v < 0.01 ? v.toFixed(5) : v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : fmtInt(v)) + (v === 0 ? '' : ' BTC');
export const fmtMin = (m: number) => (m < 1 ? `${Math.round(m * 60)}s` : m < 60 ? `${Math.floor(m)}m ${Math.round((m % 1) * 60)}s` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`);
export const fmtDate = (t: number, withTime = false) => new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' } : { timeZone: 'UTC' }) });
export function ago(t: number) {
  const s = Date.now() / 1000 - t;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = s / 86400;
  if (d < 60) return `${Math.floor(d)} days ago`;
  if (d < 730) return `${Math.floor(d / 30.4)} months ago`;
  return `${Math.floor(d / 365.25)} years ago`;
}
