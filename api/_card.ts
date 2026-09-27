// Layout for the link-preview image (rendered by api/og.ts). Kept separate so it can be tested without the renderer.
type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, ...children: (Node | string)[]): Node =>
  ({ type, props: { style: { display: 'flex', ...style }, children: children.length === 1 ? children[0] : children } });
const fmt = (n: number) => n.toLocaleString('en-US');

export async function card(h: number | null) {
  let when = '', txs = '', miner = '';
  if (h !== null) {
    try {
      const hash = (await (await fetch(`https://mempool.space/api/block-height/${h}`)).text()).trim();
      const b = await (await fetch(`https://mempool.space/api/v1/block/${hash}`)).json();
      when = new Date(b.timestamp * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      txs = `${fmt(b.tx_count)} transactions`;
      miner = b.extras?.pool?.name ? `mined by ${b.extras.pool.name}` : '';
    } catch { /* fall back to the number alone */ }
  }
  // a short run of chain with the chosen block lit up
  const cubes = [.35, .5, .7, 1, .7, .5, .35].map((a, i) => el('div', {
    width: i === 3 ? 150 : 96, height: i === 3 ? 150 : 96, marginLeft: i ? 34 : 0, borderRadius: 6,
    border: `${i === 3 ? 4 : 3}px solid rgba(255, 176, 80, ${a})`,
    background: i === 3 ? 'rgba(247,147,26,.28)' : 'rgba(247,147,26,.06)',
    boxShadow: i === 3 ? '0 0 80px rgba(247,147,26,.8)' : `0 0 ${30 * a}px rgba(247,147,26,${a * .5})`,
  }));
  const tree = el('div', {
    width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 72px',
    background: 'radial-gradient(ellipse at 50% 45%, #2a1604 0%, #0a0806 55%, #04050a 100%)', color: '#EEEAE2', fontFamily: 'sans-serif',
  },
    el('div', { justifyContent: 'space-between', alignItems: 'center', fontSize: 30, color: 'rgba(238,234,226,.6)' },
      el('div', {}, 'The Chain'),
      el('div', { color: '#F7931A', fontSize: 24, letterSpacing: 4 }, h === null ? 'EVERY BITCOIN BLOCK · LIVE' : 'BITCOIN BLOCK')),
    el('div', { alignItems: 'center', justifyContent: 'center' }, ...cubes),
    el('div', { flexDirection: 'column' },
      el('div', { fontSize: h === null ? 76 : 110, fontWeight: 700, letterSpacing: -3, lineHeight: 1 }, h === null ? 'Find your block' : `#${fmt(h)}`),
      el('div', { fontSize: 34, color: 'rgba(238,234,226,.7)', marginTop: 14 },
        h === null ? 'Every Bitcoin block ever mined, linked in one chain.' : [when, txs, miner].filter(Boolean).join(' · ') || 'Every Bitcoin block ever mined, linked in one chain.')),
  );
  return tree;
}

