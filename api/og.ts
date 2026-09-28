// Link-preview image for a block: /api/og?h=840000 (no h: a generic card for the site).
// Runs on the Node.js runtime: satori lays out the card, resvg turns the SVG into a PNG.
import fs from 'node:fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { card } from './_card.js';

let font: Buffer | null = null;
const loadFont = () => (font ??= fs.readFileSync(new URL('./_fonts/Geist-Regular.ttf', import.meta.url)));

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('h');
  const h = q !== null && /^\d{1,7}$/.test(q) ? +q : null;
  const svg = await satori(await card(h) as any, {
    width: 1200, height: 630,
    fonts: [{ name: 'sans-serif', data: loadFont(), weight: 400, style: 'normal' }],
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  return new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      'cache-control': h === null ? 'public, max-age=3600' : 'public, max-age=86400, s-maxage=31536000, immutable',
    },
  });
}
