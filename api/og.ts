// Link-preview image for a block: /api/og?h=840000 (no h: a generic card for the site).
// Runs on the Node.js runtime: satori lays out the card, resvg turns the SVG into a PNG.
// Dependencies load lazily so a failure is reported with its stage instead of crashing the function.
import fs from 'node:fs';
import path from 'node:path';

let font: Buffer | null = null;
function loadFont() {
  if (font) return font;
  const candidates = [
    path.join(process.cwd(), 'api/_fonts/Geist-Regular.ttf'),
    new URL('./_fonts/Geist-Regular.ttf', import.meta.url),
  ];
  for (const c of candidates) { try { return (font = fs.readFileSync(c)); } catch { /* try next */ } }
  throw new Error('font not found in ' + candidates.map(String).join(', '));
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('h');
  const h = q !== null && /^\d{1,7}$/.test(q) ? +q : null;
  let stage = 'card';
  try {
    const { card } = await import('./_card.js');
    stage = 'satori';
    const satori = (await import('satori')).default;
    const svg = await satori(await card(h) as any, {
      width: 1200, height: 630,
      fonts: [{ name: 'sans-serif', data: loadFont(), weight: 400, style: 'normal' }],
    });
    stage = 'resvg';
    const { Resvg } = await import('@resvg/resvg-js');
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
    return new Response(new Uint8Array(png), {
      headers: {
        'content-type': 'image/png',
        'cache-control': h === null ? 'public, max-age=3600' : 'public, max-age=86400, s-maxage=31536000, immutable',
      },
    });
  } catch (e) {
    return new Response(`og failed at ${stage}: ${(e as Error)?.stack ?? e}`, { status: 500, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }
}
