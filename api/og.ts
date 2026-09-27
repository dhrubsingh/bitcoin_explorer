// Link-preview image for a block: /api/og?h=840000 (no h: a generic card for the site).
import { ImageResponse } from '@vercel/og';
import { card } from './_card';

export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  const q = new URL(req.url).searchParams.get('h');
  const h = q !== null && /^\d{1,7}$/.test(q) ? +q : null;
  return new ImageResponse(await card(h) as any, {
    width: 1200, height: 630,
    headers: { 'Cache-Control': h === null ? 'public, max-age=3600' : 'public, max-age=86400, s-maxage=31536000, immutable' },
  });
}
