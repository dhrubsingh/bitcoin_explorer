import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Chain, Metric, fmtInt, metricValue } from './data';

/*
 * The chain lies along one Archimedean spiral: genesis near the centre, the newest block on the
 * outside. Near the tip the curve is so gentle it reads as a straight chain; zoomed out, the whole
 * history is visible as a coil. Positions are computed in float64 on the CPU and handed to the GPU
 * in a texture, so blocks stay precisely aligned ~1,000 units from the origin.
 */
const TEX_W = 2048;
const PITCH = 4.5;               // distance between spiral arms
const STEP = 1.75;               // distance between consecutive blocks along the chain
const B = PITCH / (2 * Math.PI);
const THETA0 = 6 * Math.PI;
const L0 = B * THETA0 * THETA0 / 2;
const TAU = Math.PI * 2;
const LINK_WINDOW = 6000;        // links are drawn for the stretch of chain around the camera focus

export const POOL_COLORS = ['#3A3E4A', '#F7931A', '#5FD4C4', '#A78BFA', '#60A5FA', '#F4D35E', '#F472B6', '#34D399', '#FB7185', '#93C5FD', '#FDBA74', '#86EFAC', '#C4B5FD', '#FCA5A5', '#67E8F9', '#D9F99D'];
export const poolColor = (i: number) => (i === 0 ? POOL_COLORS[0] : POOL_COLORS[1 + ((i - 1) % 15)]);

const tf: Record<Metric, (v: number) => number> = {
  tx: v => Math.log1p(v), pool: v => Math.log1p(v), fees: v => Math.log10(1 + v * 1e5), size: v => Math.log1p(v * 8), interval: v => Math.log1p(v),
};

export function blockPos(i: number) {
  const th = Math.sqrt(2 * (L0 + i * STEP) / B), r = B * th;
  const x = r * Math.cos(th), z = -r * Math.sin(th);
  const tx = B * Math.cos(th) - r * Math.sin(th), tz = -(B * Math.sin(th) + r * Math.cos(th));
  return { x, z, phi: Math.atan2(tz, tx) };
}

const common = /* glsl */ `
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 ember(float t) {
  vec3 c0 = lin(vec3(.42,.16,.05)), c1 = lin(vec3(.78,.32,.05)), c2 = lin(vec3(.97,.58,.10)), c3 = lin(vec3(1.,.76,.38)), c4 = lin(vec3(1.,.92,.76));
  if (t < .3) return mix(c0, c1, t / .3);
  if (t < .62) return mix(c1, c2, (t - .3) / .32);
  if (t < .86) return mix(c2, c3, (t - .62) / .24);
  return mix(c3, c4, (t - .86) / .14);
}`;

const blockVert = /* glsl */ `
uniform sampler2D uData, uPos;
uniform float uMix, uCut, uReveal, uHover, uSel, uNewest, uTime, uPools, uFocus, uFar;
uniform vec3 uPal[16];
out vec3 vCol; out vec3 vLocal; out vec3 vN; out float vDim;
${common}
void main() {
  int id = gl_InstanceID; float fid = float(id);
  ivec2 uv = ivec2(id % ${TEX_W}, id / ${TEX_W});
  vec4 d = texelFetch(uData, uv, 0), p = texelFetch(uPos, uv, 0);
  float t = mix(d.g, d.r, uMix);
  float lim = min(uCut, uReveal);
  bool hov = abs(fid - uHover) < .5, sel = abs(fid - uSel) < .5, newest = abs(fid - uNewest) < .5;
  float grow = clamp((lim - fid) / 14000., 0., 1.);
  // up close, only the stretch of chain in focus is shown; the coil's other loops shrink to faint specks
  float away = smoothstep(250., 1400., abs(fid - uFocus)) * (1. - uFar);
  float sz = mix(.42, 1.2, t) * grow * (sel ? 1.2 : 1.) * mix(1., .07, away);
  if (fid > lim) sz = 0.;
  vec3 tang = vec3(cos(p.z), 0., sin(p.z)), nrm = vec3(-sin(p.z), 0., cos(p.z));
  vec3 lp = position * sz;
  vec3 wp = vec3(p.x, sz * .5, p.y) + tang * lp.x + nrm * lp.z + vec3(0., lp.y, 0.);
  vLocal = position;
  vN = normal.x * tang + vec3(0., normal.y, 0.) + normal.z * nrm;
  vec3 c;
  if (uPools > .5) { int pi = int(d.b + .5); c = lin(pi == 0 ? uPal[0] : uPal[1 + (pi - 1) % 15]) * (pi == 0 ? .8 : 1.1); }
  else c = ember(t);
  if (newest) c *= 1.5 + .6 * sin(uTime * 3.);
  if (hov) c = c * 1.6 + vec3(.15);
  if (sel) c = lin(vec3(1., .95, .85)) * 1.6;
  vDim = mix(1., .25, away) * ((uSel > -.5 && !sel) ? .55 : 1.);
  vCol = c;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.);
}`;
const blockFrag = /* glsl */ `
uniform float uFar;
in vec3 vCol; in vec3 vLocal; in vec3 vN; in float vDim;
out vec4 fragColor;
void main() {
  vec3 a = abs(vLocal);
  float mx = max(a.x, max(a.y, a.z)), mn = min(a.x, min(a.y, a.z));
  float e = .5 - (a.x + a.y + a.z - mx - mn);            // distance to the nearest edge of this face
  float w = fwidth(e);
  float edge = (1. - smoothstep(.035, .035 + w * 1.5 + .004, e)) * (1. - uFar);
  float l = .55 + .45 * max(dot(normalize(vN), normalize(vec3(.3, 1., .2))), 0.);
  vec3 c = vCol * mix(.14, .8, uFar) * l + vCol * edge * 1.05;
  fragColor = vec4(c * vDim, 1.);
}`;
const linkVert = /* glsl */ `
uniform sampler2D uPos;
uniform float uStart, uLim, uFocus, uFar;
void main() {
  int j = int(uStart) + gl_InstanceID;
  vec4 a = texelFetch(uPos, ivec2((j - 1) % ${TEX_W}, (j - 1) / ${TEX_W}), 0);
  vec4 b = texelFetch(uPos, ivec2(j % ${TEX_W}, j / ${TEX_W}), 0);
  vec2 d = b.xy - a.xy; float len = length(d); vec2 dir = d / max(len, 1e-4);
  vec3 tang = vec3(dir.x, 0., dir.y), nrm = vec3(-dir.y, 0., dir.x);
  vec3 mid = vec3((a.x + b.x) * .5, .2, (a.y + b.y) * .5);
  vec3 wp = mid + tang * position.x * len + nrm * position.z * .07 + vec3(0., position.y * .07, 0.);
  if (float(j) > uLim || j < 1 || (abs(float(j) - uFocus) > 1300. && uFar < .5)) wp = vec3(0., -9999., 0.);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.);
}`;
const linkFrag = /* glsl */ `
uniform float uFar; out vec4 fragColor;
void main() { fragColor = vec4(vec3(1., .42, .06) * 1.3 * (1. - uFar), 1.); }`;

function cube() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const ig = new THREE.InstancedBufferGeometry();
  ig.setIndex(g.index); ig.setAttribute('position', g.getAttribute('position')); ig.setAttribute('normal', g.getAttribute('normal'));
  return ig;
}
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!, g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();
const hexRGB = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

type Fly = { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number; dur: number };

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  labels: CSS2DRenderer;
  mat: THREE.ShaderMaterial;
  linkMat: THREE.ShaderMaterial;
  geo: THREE.InstancedBufferGeometry;
  data: Float32Array; dataTex: THREE.DataTexture;
  px: Float64Array; pz: Float64Array;
  t: Float32Array;
  metric: Metric = 'tx';
  range: [number, number] = [0, 1];
  fly: Fly | null = null;
  follow = true;
  reveal = 1; revealing = false;
  clock = new THREE.Clock();
  far = 0;
  floor: THREE.Mesh;
  pending = new THREE.Group(); pendingFill: THREE.Mesh; pendingLabel: CSS2DObject; pendingAt = new THREE.Vector3();
  fill = 0; fillTarget = .5; txRate = 4;
  sparks: THREE.Points; sparkState: { t: number; sp: number; from: THREE.Vector3 }[] = [];
  tipLabels: CSS2DObject[] = [];
  landmarkLabels: CSS2DObject[] = [];
  cloud: THREE.Points | null = null; cloudT = 0;
  onUserMove: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, labelsEl: HTMLElement, public chain: Chain) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color('#05060A');
    this.scene.fog = new THREE.FogExp2('#05060A', .01);

    this.camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, .05, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: .08, zoomToCursor: true, maxPolarAngle: 1.45, minDistance: 1.5, maxDistance: 7000, rotateSpeed: .55, zoomSpeed: 1.2 });
    this.controls.addEventListener('start', () => { this.fly = null; this.follow = false; this.onUserMove(); });

    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), .55, .4, .82));
    this.composer.addPass(new OutputPass());
    this.labels = new CSS2DRenderer({ element: labelsEl });
    this.labels.setSize(innerWidth, innerHeight);

    // textures: per-block metric data + spiral positions (precomputed for future growth too)
    const rows = Math.ceil((chain.cap + 1) / TEX_W);
    this.data = new Float32Array(TEX_W * rows * 4);
    this.dataTex = new THREE.DataTexture(this.data, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    const pos = new Float32Array(TEX_W * rows * 4);
    const posTex = new THREE.DataTexture(pos, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    for (const tx of [this.dataTex, posTex]) tx.minFilter = tx.magFilter = THREE.NearestFilter;
    this.px = new Float64Array(chain.cap + 1); this.pz = new Float64Array(chain.cap + 1);
    for (let i = 0; i <= chain.cap; i++) {
      const p = blockPos(i); this.px[i] = p.x; this.pz[i] = p.z;
      pos[i * 4] = p.x; pos[i * 4 + 1] = p.z; pos[i * 4 + 2] = p.phi;
    }
    posTex.needsUpdate = true;
    this.t = new Float32Array(chain.cap);

    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: blockVert, fragmentShader: blockFrag,
      uniforms: {
        uData: { value: this.dataTex }, uPos: { value: posTex }, uMix: { value: 1 }, uCut: { value: 1e9 }, uReveal: { value: 1e9 },
        uHover: { value: -1 }, uSel: { value: -1 }, uNewest: { value: -1 }, uTime: { value: 0 }, uPools: { value: 0 }, uFar: { value: 0 }, uFocus: { value: 0 },
        uPal: { value: POOL_COLORS.map(c => new THREE.Vector3(...hexRGB(c))) },
      },
    });
    this.geo = cube();
    const blocks = new THREE.Mesh(this.geo, this.mat); blocks.frustumCulled = false;
    this.linkMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: linkVert, fragmentShader: linkFrag,
      uniforms: { uPos: { value: posTex }, uStart: { value: 1 }, uLim: { value: 1e9 }, uFar: this.mat.uniforms.uFar, uFocus: this.mat.uniforms.uFocus },
    });
    const linkGeo = cube(); linkGeo.instanceCount = LINK_WINDOW;
    const links = new THREE.Mesh(linkGeo, this.linkMat); links.frustumCulled = false;
    this.scene.add(blocks, links);

    // the next block, being assembled from waiting transactions
    const edgeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, .5, .1).multiplyScalar(1.4), toneMapped: false });
    const beam = new THREE.BoxGeometry(1, 1, 1);
    for (const a of [-.5, .5]) for (const b of [-.5, .5]) {
      for (const [p, s] of [[[0, a, b], [1.03, .025, .025]], [[a, 0, b], [.025, 1.03, .025]], [[a, b, 0], [.025, .025, 1.03]]] as [number[], number[]][]) {
        const m = new THREE.Mesh(beam, edgeMat); m.position.set(p[0], p[1], p[2]); m.scale.set(s[0], s[1], s[2]); this.pending.add(m);
      }
    }
    this.pendingFill = new THREE.Mesh(new THREE.BoxGeometry(.92, 1, .92), new THREE.MeshBasicMaterial({ color: new THREE.Color(.95, .45, .08), transparent: true, opacity: .3, depthWrite: false, toneMapped: false }));
    this.pending.add(this.pendingFill);
    const pl = document.createElement('div'); pl.className = 'pending-lbl';
    this.pendingLabel = new CSS2DObject(pl); this.pendingLabel.position.set(0, 1.75, 0); this.pending.add(this.pendingLabel);
    this.pending.scale.setScalar(1.2);
    this.scene.add(this.pending);
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(300 * 3), 3));
    this.sparks = new THREE.Points(sg, new THREE.PointsMaterial({ size: .14, map: GLOW, color: new THREE.Color(1, .6, .2).multiplyScalar(2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.sparks.frustumCulled = false;
    for (let i = 0; i < 300; i++) this.sparkState.push({ t: 1 + Math.random(), sp: 1, from: new THREE.Vector3() });
    this.scene.add(this.sparks);

    for (let k = 0; k < 7; k++) {
      const el = document.createElement('div'); el.className = 'tip-lbl';
      const o = new CSS2DObject(el); o.userData.h = -1; this.tipLabels.push(o); this.scene.add(o);
    }
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'varying vec2 vP; void main(){ float r = length(vP); gl_FragColor = vec4(vec3(.035,.028,.03), smoothstep(1., .25, r) * .85); }',
    }));
    this.floor.rotation.x = -Math.PI / 2; this.floor.position.y = -.02;
    this.scene.add(this.floor);

    this.setMetric('tx', false);
    this.syncCount();
    addEventListener('resize', () => this.resize());
  }

  /* ---------- data ---------- */
  computeRange(m: Metric) {
    const c = this.chain, s: number[] = [];
    for (let h = 1; h < c.n; h += 7) s.push(tf[m](metricValue(c, m, h)));
    s.sort((a, b) => a - b);
    return [s[Math.floor(.01 * (s.length - 1))], s[Math.floor(.997 * (s.length - 1))]] as [number, number];
  }
  normalise(h: number) {
    const [lo, hi] = this.range, m = this.metric === 'pool' ? 'tx' : this.metric;
    return Math.min(1, Math.max(0, (tf[m](metricValue(this.chain, m, h)) - lo) / (hi - lo || 1)));
  }
  setMetric(m: Metric, animate = true) {
    this.metric = m;
    this.range = this.computeRange(m === 'pool' ? 'tx' : m);
    const d = this.data, c = this.chain;
    for (let h = 0; h < c.n; h++) { const o = h * 4, v = this.normalise(h); d[o + 1] = animate ? d[o] : v; d[o] = v; d[o + 2] = c.pool[h]; this.t[h] = v; }
    this.dataTex.needsUpdate = true;
    this.mat.uniforms.uPools.value = m === 'pool' ? 1 : 0;
    this.mat.uniforms.uMix.value = animate ? 0 : 1;
    this.tipLabels.forEach(l => (l.userData.h = -1));
  }
  writeBlock(h: number) {
    const o = h * 4, v = this.normalise(h);
    this.data[o] = this.data[o + 1] = v; this.data[o + 2] = this.chain.pool[h]; this.t[h] = v;
    this.dataTex.needsUpdate = true;
  }
  syncCount() {
    const n = this.chain.n;
    this.geo.instanceCount = n;
    this.mat.uniforms.uNewest.value = n - 1;
    this.linkMat.uniforms.uLim.value = Math.min(n - 1, this.mat.uniforms.uCut.value);
    this.floor.scale.setScalar((this.radius() + 20) * 1.25);
  }
  radius() { const p = blockPos(this.chain.n); return Math.hypot(p.x, p.z); }

  /* ---------- geometry ---------- */
  sizeOf(h: number) { return (.42 + (1.2 - .42) * this.t[h]) * (h === this.mat.uniforms.uSel.value ? 1.2 : 1); }
  centerOf(h: number) { return new THREE.Vector3(this.px[h], this.sizeOf(h) / 2, this.pz[h]); }
  /** nearest block to a ground point, via the spiral's inverse */
  nearest(x: number, z: number, lim: number) {
    const r = Math.hypot(x, z), ang = Math.atan2(-z, x);
    let best = -1, bd = 1e9;
    const k0 = Math.round((r / B - ang) / TAU);
    for (let dk = -1; dk <= 1; dk++) {
      const th = ang + TAU * (k0 + dk);
      if (th <= 0) continue;
      const i0 = Math.round((B * th * th / 2 - L0) / STEP);
      for (let i = i0 - 2; i <= i0 + 2; i++) {
        if (i < 0 || i > lim) continue;
        const d = Math.hypot(this.px[i] - x, this.pz[i] - z);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return { i: best, d: bd };
  }
  ray = new THREE.Raycaster();
  pick(nx: number, ny: number) {
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (Math.abs(d.y) < 1e-6) return -1;
    const lim = Math.min(this.chain.n - 1, Math.floor(Math.min(this.mat.uniforms.uCut.value, this.mat.uniforms.uReveal.value)));
    const tol = this.far > .5 ? 1.6 : .75;
    for (let k = 0; k <= 24; k++) {
      const y = 1.25 * (1 - k / 24), s = (y - o.y) / d.y;
      if (s < 0) continue;
      const { i, d: dist } = this.nearest(o.x + d.x * s, o.z + d.z * s, lim);
      if (i >= 0 && dist < this.sizeOf(i) * tol && y <= this.sizeOf(i) + .02) return i;
    }
    return -1;
  }

  /* ---------- camera ---------- */
  liveFrame() {
    // look along the chain from just outside the spiral: older blocks recede left, the next block sits on the right
    const portrait = innerWidth / innerHeight < 1;
    const n = this.chain.n, p = blockPos(Math.max(0, n - (portrait ? .4 : 4)));
    const dir = new THREE.Vector3(Math.cos(p.phi), 0, Math.sin(p.phi)), out = new THREE.Vector3(p.x, 0, p.z).normalize();
    const target = new THREE.Vector3(p.x, .5, p.z).addScaledVector(dir, -1.5);
    const back = portrait ? 22 : 16;
    const cam = target.clone().addScaledVector(out, back).addScaledVector(dir, -4).add(new THREE.Vector3(0, back * .42, 0));
    return { cam, target };
  }
  goLive(dur = 1.6) { this.follow = true; const { cam, target } = this.liveFrame(); this.flyTo(cam, target, dur); }
  overview(dur = 2.2) {
    this.follow = false;
    const R = this.radius();
    this.flyTo(new THREE.Vector3(0, R * 2.3, R * 1.3), new THREE.Vector3(0, 0, 0), dur);
  }
  focusBlock(h: number) {
    this.follow = false;
    const c = this.centerOf(h), p = blockPos(h);
    const dir = new THREE.Vector3(Math.cos(p.phi), 0, Math.sin(p.phi)), out = new THREE.Vector3(p.x, 0, p.z).normalize();
    this.flyTo(c.clone().addScaledVector(out, 7).addScaledVector(dir, -2.5).add(new THREE.Vector3(0, 3.8, 0)), c.clone().setY(c.y + .6), 1.6);
  }
  flyTo(to: THREE.Vector3, target: THREE.Vector3, dur: number) {
    this.fly = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: target, t: 0, dur };
  }

  /* ---------- interaction ---------- */
  hover(h: number) { this.mat.uniforms.uHover.value = h; }
  select(h: number) {
    this.mat.uniforms.uSel.value = h;
    if (this.cloud) { this.scene.remove(this.cloud); this.cloud.geometry.dispose(); this.cloud = null; }
  }
  setCut(h: number) { this.mat.uniforms.uCut.value = h; this.linkMat.uniforms.uLim.value = Math.min(this.chain.n - 1, h); }
  playReveal() { this.reveal = 0; this.revealing = true; }
  setMempool(fill: number, txPerSec: number) { this.fillTarget = Math.max(.05, Math.min(1, fill)); this.txRate = Math.max(.5, Math.min(30, txPerSec)); }
  pendingText(html: string) { this.pendingLabel.element.innerHTML = html; }
  /** dots above the selected block, one per transaction (capped), coloured by fee rate */
  showTxCloud(h: number, feeRange?: number[]) {
    const n = Math.min(this.chain.tx[h], 2500), c0 = this.centerOf(h);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color();
    const fr = feeRange?.length ? feeRange : [1, 2, 4, 8, 16, 32, 64];
    const lo = Math.log(Math.max(1, fr[0])), hi = Math.log(Math.max(2, fr[fr.length - 1]));
    let seed = h * 9301 + 49297; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const top = c0.y * 2 + .5;
    for (let i = 0; i < n; i++) {
      const k = i / Math.max(1, n - 1), a = i * 2.39996, rr = .1 + .9 * Math.sqrt(k);
      pos[i * 3] = c0.x + Math.cos(a) * rr; pos[i * 3 + 1] = top + k * 1.6 + (rnd() - .5) * .08; pos[i * 3 + 2] = c0.z + Math.sin(a) * rr;
      const q = rnd() * (fr.length - 1), j = Math.floor(q), fee = fr[j] + (fr[Math.min(j + 1, fr.length - 1)] - fr[j]) * (q - j);
      const t = Math.min(1, Math.max(0, (Math.log(Math.max(1, fee)) - lo) / (hi - lo || 1)));
      c.setHSL(.07 + t * .06, .95, .35 + t * .4).multiplyScalar(1.6);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (this.cloud) { this.scene.remove(this.cloud); this.cloud.geometry.dispose(); }
    this.cloud = new THREE.Points(g, new THREE.PointsMaterial({ size: .05, map: GLOW, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    this.cloudT = 0; this.scene.add(this.cloud);
  }
  addLandmarks(list: { h: number; name: string }[]) {
    for (const l of list) {
      if (l.h >= this.chain.n) continue;
      const el = document.createElement('div'); el.className = 'lm-lbl'; el.textContent = l.name;
      const o = new CSS2DObject(el); o.position.set(this.px[l.h], 1.4, this.pz[l.h]); o.userData.h = l.h;
      this.landmarkLabels.push(o); this.scene.add(o);
    }
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); this.labels.setSize(innerWidth, innerHeight);
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), .05), u = this.mat.uniforms, n = this.chain.n;
    u.uTime.value += dt;
    if (u.uMix.value < 1) u.uMix.value = Math.min(1, u.uMix.value + dt * 1.6);
    if (this.revealing) {
      this.reveal = Math.min(1, this.reveal + dt / 5);
      const k = 1 - Math.pow(1 - this.reveal, 2.4);
      u.uReveal.value = this.reveal >= 1 ? 1e9 : k * (n + 14000);
      if (this.reveal >= 1) this.revealing = false;
    }
    if (this.fly) {
      const f = this.fly; f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < .5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.from, f.to, e);
      this.controls.target.lerpVectors(f.tFrom, f.tTo, e);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update();

    // distance-driven look: crisp edges and links up close, a glowing coil from afar
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.far = THREE.MathUtils.smoothstep(dist, 30, 260);
    u.uFar.value = this.far;
    (this.scene.fog as THREE.FogExp2).density = .45 / Math.max(10, dist);
    this.camera.near = Math.max(.05, dist * .004); this.camera.far = dist * 30 + 200; this.camera.updateProjectionMatrix();

    const focus = this.nearest(this.controls.target.x, this.controls.target.z, n - 1).i;
    u.uFocus.value = focus < 0 ? n : focus;
    this.linkMat.uniforms.uStart.value = Math.max(1, Math.min(n - LINK_WINDOW + 1, (focus < 0 ? n : focus) - LINK_WINDOW / 2));

    // next block + incoming transactions
    const cut = u.uCut.value;
    const pp = blockPos(n), target = new THREE.Vector3(pp.x, .6, pp.z);
    if (this.pendingAt.lengthSq() === 0) this.pendingAt.copy(target);
    this.pendingAt.lerp(target, 1 - Math.exp(-dt * 4));
    this.pending.position.copy(this.pendingAt);
    this.pending.rotation.y = -pp.phi;
    this.pending.visible = cut >= n - 1 && !this.revealing && this.far < .95;
    this.fill += (this.fillTarget - this.fill) * (1 - Math.exp(-dt * 2));
    this.pendingFill.scale.y = Math.max(.01, this.fill);
    this.pendingFill.position.y = -.5 + this.fill * .5;
    (this.pendingFill.material as THREE.MeshBasicMaterial).opacity = .22 + .1 * Math.sin(u.uTime.value * 2.2);
    const sp = this.sparks.geometry.attributes.position.array as Float32Array;
    let spawn = this.txRate * dt;
    this.sparkState.forEach((s, i) => {
      if (s.t >= 1 && spawn > Math.random()) {
        spawn -= 1; s.t = 0; s.sp = .5 + Math.random() * .5;
        s.from.set((Math.random() - .5) * 16, 1.5 + Math.random() * 7, (Math.random() - .5) * 16).add(this.pendingAt);
      }
      if (s.t < 1) {
        s.t += dt * s.sp * .7;
        const e = s.t * s.t;
        sp[i * 3] = s.from.x + (this.pendingAt.x - s.from.x) * e; sp[i * 3 + 1] = s.from.y + (this.pendingAt.y - s.from.y) * e; sp[i * 3 + 2] = s.from.z + (this.pendingAt.z - s.from.z) * e;
      } else sp[i * 3 + 1] = -9999;
    });
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.visible = this.pending.visible;

    const close = this.far < .25;
    this.tipLabels.forEach((l, k) => {
      const h = n - 1 - k;
      l.visible = close && h >= 0 && h <= cut && !this.revealing;
      if (!l.visible) return;
      if (l.userData.h !== h) { l.userData.h = h; l.element.innerHTML = `<b>#${fmtInt(h)}</b><span>${fmtInt(this.chain.tx[h])} tx</span>`; }
      l.position.set(this.px[h], this.sizeOf(h) + .7, this.pz[h]);
    });
    this.landmarkLabels.forEach(l => { l.visible = this.far > .6 && l.userData.h <= Math.min(cut, u.uReveal.value); });
    if (this.cloud) { this.cloudT = Math.min(1, this.cloudT + dt * 1.5); (this.cloud.material as THREE.PointsMaterial).opacity = this.cloudT; }

    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
