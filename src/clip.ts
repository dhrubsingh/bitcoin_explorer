import * as THREE from 'three';
import type { View } from './view';
import type { Sound } from './audio';

export interface ClipText { kicker: string; big: string; sub: string; foot: string }

/** Pick a format X accepts where the browser can record it (MP4 in Chrome 126+ and Safari), else WebM. */
function mime() {
  for (const m of ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'])
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
export const canRecord = () => !!mime() && 'captureStream' in HTMLCanvasElement.prototype;

/**
 * Records a square clip: the camera orbits block `h` while a title card is composited over the
 * frames. Audio from the site's sound engine is included when sound is on.
 */
export function recordClip(view: View, sound: Sound, h: number, text: ClipText, seconds = 6, onProgress?: (f: number) => void): Promise<{ blob: Blob; ext: string }> {
  return new Promise((resolve, reject) => {
    const type = mime();
    if (!type) return reject(new Error('Recording is not supported in this browser.'));
    const S = 1080, comp = document.createElement('canvas'); comp.width = comp.height = S;
    const g = comp.getContext('2d')!;
    const src = view.renderer.domElement;
    const stream = comp.captureStream(30);
    if (sound.on && sound.dest) sound.dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      view.onAfterRender = null; view.shotting = false; view.controls.enabled = true;
      resolve({ blob: new Blob(chunks, { type: type.split(';')[0] }), ext: type.includes('mp4') ? 'mp4' : 'webm' });
    };

    const c = view.centerOf(h);
    const center = new THREE.Vector3(c.x, c.y + .4, c.z);
    const out = new THREE.Vector3(c.x, 0, c.z).normalize();
    const a0 = Math.atan2(out.z, out.x);
    const t0 = performance.now();
    view.fly = null; view.drift = null; view.shotting = true; view.controls.enabled = false;
    const pose = (k: number) => {
      const a = a0 - .55 + k * 1.1, r = 7.5 - k * 1.6, y = 3.2 - k * .9;
      view.camera.position.set(center.x + Math.cos(a) * r, center.y + y, center.z + Math.sin(a) * r);
      view.controls.target.copy(center);
    };
    pose(0);

    view.onAfterRender = () => {
      const k = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      // crop the centre square of the live frame
      const w = src.width, hh = src.height, s = Math.min(w, hh);
      g.drawImage(src, (w - s) / 2, (hh - s) / 2, s, s, 0, 0, S, S);
      const grad = g.createLinearGradient(0, S * .45, 0, S);
      grad.addColorStop(0, 'rgba(4,5,10,0)'); grad.addColorStop(1, 'rgba(4,5,10,.9)');
      g.fillStyle = grad; g.fillRect(0, S * .45, S, S * .55);
      const fade = Math.min(1, k * 4);
      g.globalAlpha = fade;
      g.fillStyle = '#F7931A'; g.font = '500 30px "Geist Mono", monospace'; g.fillText(text.kicker.toUpperCase(), 72, S - 270);
      g.fillStyle = '#EEEAE2'; g.font = '600 150px Geist, system-ui, sans-serif'; g.fillText(text.big, 64, S - 130);
      g.fillStyle = 'rgba(238,234,226,.7)'; g.font = '400 34px Geist, system-ui, sans-serif'; g.fillText(text.sub, 72, S - 78);
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(238,234,226,.55)'; g.font = 'italic 40px "Instrument Serif", Georgia, serif'; g.fillText('The Chain', 72, 96);
      g.font = '500 24px "Geist Mono", monospace'; g.textAlign = 'right'; g.fillText(text.foot, S - 72, 92); g.textAlign = 'left';
      onProgress?.(k);
      if (k >= 1) { if (rec.state === 'recording') rec.stop(); return; }
      pose(k);
    };
    rec.start(250);
  });
}
