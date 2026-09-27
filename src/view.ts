import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Chain, Metric, metricValue } from './data';

export const PER_RING = 2016;
const R0 = 1.2, DR = 0.1, TEX_W = 2048;
const TAU = Math.PI * 2;

/** Categorical colours for mining pools (index 0 = unknown). */
export const POOL_COLORS = ['#3A3E4A', '#F7931A', '#5FD4C4', '#A78BFA', '#60A5FA', '#F4D35E', '#F472B6', '#34D399', '#FB7185', '#93C5FD', '#FDBA74', '#86EFAC', '#C4B5FD', '#FCA5A5', '#67E8F9', '#D9F99D'];
export const poolColor = (i: number) => (i === 0 ? POOL_COLORS[0] : POOL_COLORS[1 + ((i - 1) % 15)]);

/* metric → 0..1, log-scaled, clipped to the bulk of the data */
const tf: Record<Metric, (v: number) => number> = {
  tx: v => Math.log1p(v), pool: v => Math.log1p(v),
  fees: v => Math.log10(1 + v * 1e5), size: v => Math.log1p(v * 8), interval: v => Math.log1p(v),
};
const itf: Record<Metric, (y: number) => number> = {
  tx: y => Math.expm1(y), pool: y => Math.expm1(y),
  fees: y => (Math.pow(10, y) - 1) / 1e5, size: y => Math.expm1(y) / 8, interval: y => Math.expm1(y),
};

const vert = /* glsl */ `
uniform sampler2D uData;
uniform float uMix, uCut, uReveal, uHover, uSel, uNewest, uTime, uPools, uR0, uDR, uHmax;
uniform vec3 uPal[16];
out vec3 vCol; out float vY; out vec3 vN; out float vDim;
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 ember(float t) {
  vec3 c0 = lin(vec3(.34,.13,.04)), c1 = lin(vec3(.62,.24,.04)), c2 = lin(vec3(.97,.58,.10)), c3 = lin(vec3(1.,.74,.36)), c4 = lin(vec3(1.,.9,.72));
  if (t < .3) return mix(c0, c1, t / .3);
  if (t < .62) return mix(c1, c2, (t - .3) / .32);
  if (t < .86) return mix(c2, c3, (t - .62) / .24);
  return mix(c3, c4, (t - .86) / .14);
}
void main() {
  int id = gl_InstanceID;
  float fid = float(id);
  vec4 d = texelFetch(uData, ivec2(id % ${TEX_W}, id / ${TEX_W}), 0);
  float t = mix(d.g, d.r, uMix);
  float e = floor(fid / ${PER_RING}.0), s = fid - e * ${PER_RING}.0;
  float r = uR0 + e * uDR;
  float th = (s + .5) / ${PER_RING}.0 * 6.28318530718;
  vec3 radial = vec3(cos(th), 0., sin(th)), tang = vec3(-sin(th), 0., cos(th));
  float lim = min(uCut, uReveal);
  float grow = clamp((lim - fid) / 9000., 0., 1.);
  bool hov = abs(fid - uHover) < .5, sel = abs(fid - uSel) < .5;
  float h = (.03 + t * uHmax) * grow + ((hov || sel) ? .3 : 0.);
  float w = max(6.28318530718 * r / ${PER_RING}.0 * .9, .0025);
  vec3 wp = radial * r + tang * (position.x * w) + radial * (position.z * uDR * .78) + vec3(0., position.y * h, 0.);
  if (fid > lim) wp = vec3(0., -9999., 0.);
  vN = normal.x * tang + vec3(0., normal.y, 0.) + normal.z * radial;
  vY = position.y;
  vec3 c;
  if (uPools > .5) {
    int pi = int(d.b + .5);
    c = lin(pi == 0 ? uPal[0] : uPal[1 + (pi - 1) % 15]) * (pi == 0 ? .7 : 1.25);
  } else {
    float tc = pow(t, 1.6);
    c = ember(tc) * (.42 + .8 * tc * tc);
  }
  if (fid > uNewest - .5 && fid < uNewest + .5) c = mix(c, lin(vec3(1., .85, .6)), .6) * (1.8 + .9 * sin(uTime * 4.));
  if (hov) c = c * 1.7 + vec3(.2);
  if (sel) c = lin(vec3(1., .93, .8)) * 2.4;
  vDim = (uSel > -.5 && !sel) ? .5 : 1.;
  vCol = c;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.);
}`;
const frag = /* glsl */ `
in vec3 vCol; in float vY; in vec3 vN; in float vDim;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vN);
  float l = .45 + .55 * max(dot(n, normalize(vec3(.35, 1., .25))), 0.);
  float top = vY > .999 ? .3 : 0.;
  fragColor = vec4(vCol * (l * mix(.3, 1., vY) + top) * vDim, 1.);
}`;

/** unit bar: x,z in [-.5,.5], y in [0,1], no bottom face */
function barGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, .5, 0);
  const idx = g.index!.array as Uint16Array;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (6 indices per face); drop -y
  const keep: number[] = [];
  for (let f = 0; f < 6; f++) if (f !== 3) for (let k = 0; k < 6; k++) keep.push(idx[f * 6 + k]);
  const ig = new THREE.InstancedBufferGeometry();
  ig.setIndex(keep);
  ig.setAttribute('position', g.getAttribute('position'));
  ig.setAttribute('normal', g.getAttribute('normal'));
  return ig;
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!, g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(255,255,255,.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  labels: CSS2DRenderer;
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  tex: THREE.DataTexture;
  texData: Float32Array;
  t: Float32Array;               // current normalised metric per block (for picking)
  metric: Metric = 'tx';
  range: [number, number] = [0, 1];
  cloud: THREE.Points | null = null;
  cloudT = 0;
  fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number; dur: number } | null = null;
  reveal = 0;
  revealing = false;
  clock = new THREE.Clock();
  guides = new THREE.Group();
  interacted = false;
  hmax = 1;

  constructor(canvas: HTMLCanvasElement, labelsEl: HTMLElement, public chain: Chain) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color('#06070B');
    this.scene.fog = new THREE.FogExp2('#06070B', .0065);

    this.camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, .02, 800);
    this.camera.position.set(0, 150, 150);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: .07, zoomToCursor: true, maxPolarAngle: 1.4, minDistance: .35, maxDistance: 260, autoRotate: true, autoRotateSpeed: .22, rotateSpeed: .6 });
    this.controls.addEventListener('start', () => { this.interacted = true; this.controls.autoRotate = false; this.fly = null; });

    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), .55, .5, .82));
    this.composer.addPass(new OutputPass());

    this.labels = new CSS2DRenderer({ element: labelsEl });
    this.labels.setSize(innerWidth, innerHeight);

    // bar height scales with the disc so the rings stay legible at any chain length
    this.hmax = Math.max(.5, (R0 + (chain.n / PER_RING) * DR) * .04);
    const rows = Math.ceil(chain.cap / TEX_W);
    this.texData = new Float32Array(TEX_W * rows * 4);
    this.tex = new THREE.DataTexture(this.texData, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.t = new Float32Array(chain.cap);

    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag,
      uniforms: {
        uData: { value: this.tex }, uMix: { value: 1 }, uCut: { value: 1e9 }, uReveal: { value: 0 },
        uHover: { value: -1 }, uSel: { value: -1 }, uNewest: { value: -1 }, uTime: { value: 0 }, uPools: { value: 0 },
        uR0: { value: R0 }, uDR: { value: DR }, uHmax: { value: this.hmax },
        // raw sRGB values; the shader linearises them
        uPal: { value: POOL_COLORS.map(c => new THREE.Vector3(...hexRGB(c))) },
      },
    });
    this.geo = barGeometry();
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh, this.guides);
    this.buildGround();
    this.setMetric('tx', false);
    this.syncCount();
    addEventListener('resize', () => this.resize());
  }

  /* ---------- data → texture ---------- */
  computeRange(m: Metric) {
    const c = this.chain, sample: number[] = [];
    for (let h = 1; h < c.n; h += 7) sample.push(tf[m](metricValue(c, m, h)));
    sample.sort((a, b) => a - b);
    const q = (p: number) => sample[Math.floor(p * (sample.length - 1))];
    return [m === 'interval' ? 0 : q(.01), m === 'interval' ? Math.log1p(60) : q(.997)] as [number, number];
  }
  normalise(h: number) {
    const [lo, hi] = this.range;
    return Math.min(1, Math.max(0, (tf[this.metric](metricValue(this.chain, this.metric, h)) - lo) / (hi - lo || 1)));
  }
  setMetric(m: Metric, animate = true) {
    this.metric = m;
    this.range = this.computeRange(m);
    const d = this.texData, c = this.chain;
    for (let h = 0; h < c.n; h++) {
      const o = h * 4, v = this.normalise(h);
      d[o + 1] = animate ? d[o] : v; d[o] = v; d[o + 2] = c.pool[h]; this.t[h] = v;
    }
    this.tex.needsUpdate = true;
    this.mat.uniforms.uPools.value = m === 'pool' ? 1 : 0;
    this.mat.uniforms.uMix.value = animate ? 0 : 1;
  }
  legendRange() { return [itf[this.metric](this.range[0]), itf[this.metric](this.range[1])]; }
  writeBlock(h: number) {
    const o = h * 4, v = this.normalise(h);
    this.texData[o] = this.texData[o + 1] = v; this.texData[o + 2] = this.chain.pool[h]; this.t[h] = v;
    this.tex.needsUpdate = true;
  }
  syncCount() {
    this.geo.instanceCount = this.chain.n;
    this.mat.uniforms.uNewest.value = this.chain.n - 1;
  }

  /* ---------- guides: ground, halvings, years ---------- */
  buildGround() {
    const c = this.chain;
    const rMax = R0 + (c.n / PER_RING) * DR + 3;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(rMax + 30, 160), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uR: { value: rMax } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'uniform float uR; varying vec2 vP; void main(){ float r = length(vP) / uR; float a = smoothstep(1.25, .2, r) * .9; gl_FragColor = vec4(vec3(.022,.024,.034) + vec3(.018,.01,.0) * smoothstep(1., .3, r), a); }',
    }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -.01;
    this.guides.add(ground);
    const circle = (r: number, color: string, op: number) => {
      const pts: number[] = [];
      for (let i = 0; i <= 256; i++) { const a = i / 256 * TAU; pts.push(Math.cos(a) * r, .002, Math.sin(a) * r); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op }));
    };
    const label = (html: string, r: number, ang: number, cls: string) => {
      const el = document.createElement('div'); el.className = 'ring-lbl ' + cls; el.innerHTML = html;
      const o = new CSS2DObject(el); o.position.set(Math.cos(ang) * r, .05, Math.sin(ang) * r); this.guides.add(o);
    };
    // years
    let y = new Date(c.time[0] * 1000).getUTCFullYear() + 1;
    for (let h = 0; h < c.n; h++) {
      if (new Date(c.time[h] * 1000).getUTCFullYear() >= y) {
        const r = R0 + Math.floor(h / PER_RING) * DR - DR / 2;
        this.guides.add(circle(r, '#8A8FA3', .12));
        if (y % 2 === 0) label(String(y), r, Math.PI / 2 + .02, '');
        y++;
      }
    }
    // halvings
    [[210000, '1st halving · 2012'], [420000, '2nd halving · 2016'], [630000, '3rd halving · 2020'], [840000, '4th halving · 2024'], [1050000, '5th halving']].forEach(([h, name]) => {
      if ((h as number) >= c.n) return;
      const r = R0 + ((h as number) / PER_RING) * DR - DR / 2;
      this.guides.add(circle(r, '#5FD4C4', .5));
      label(name as string, r, -Math.PI / 2 - .12 - (h as number) / 4e6, 'halving');
    });
  }

  /* ---------- geometry helpers ---------- */
  heightOf(h: number) { return .03 + this.t[h] * this.hmax; }
  topOf(h: number) {
    const e = Math.floor(h / PER_RING), s = h - e * PER_RING, r = R0 + e * DR, th = (s + .5) / PER_RING * TAU;
    return new THREE.Vector3(Math.cos(th) * r, this.heightOf(h), Math.sin(th) * r);
  }
  idAt(x: number, z: number, n: number) {
    const r = Math.hypot(x, z), e = Math.round((r - R0) / DR);
    if (e < 0 || Math.abs(r - (R0 + e * DR)) > DR * .5) return -1;
    let th = Math.atan2(z, x); if (th < 0) th += TAU;
    const id = e * PER_RING + Math.min(PER_RING - 1, Math.floor(th / TAU * PER_RING));
    return id < n ? id : -1;
  }
  ray = new THREE.Raycaster();
  pick(nx: number, ny: number) {
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    const n = Math.min(this.chain.n, Math.floor(Math.min(this.mat.uniforms.uCut.value, this.mat.uniforms.uReveal.value)) + 1);
    if (Math.abs(d.y) < 1e-5) return -1;
    const steps = 40, top = .03 + this.hmax + .05;
    for (let k = 0; k <= steps; k++) {
      const y = top * (1 - k / steps), s = (y - o.y) / d.y;
      if (s < 0) continue;
      const id = this.idAt(o.x + d.x * s, o.z + d.z * s, n);
      if (id >= 0 && this.heightOf(id) >= y - .001) return id;
    }
    return -1;
  }

  /* ---------- interaction ---------- */
  hover(h: number) { this.mat.uniforms.uHover.value = h; }
  select(h: number, fly = true) {
    this.mat.uniforms.uSel.value = h;
    if (this.cloud) { this.scene.remove(this.cloud); this.cloud.geometry.dispose(); this.cloud = null; }
    if (h >= 0 && fly) this.flyTo(h);
  }
  flyTo(h: number, dist = 3.2) {
    const top = this.topOf(h);
    const out = new THREE.Vector3(top.x, 0, top.z).normalize();
    if (out.lengthSq() < .5) out.set(0, 0, 1);
    const tang = new THREE.Vector3(-out.z, 0, out.x);
    const to = top.clone().add(out.multiplyScalar(dist)).add(tang.multiplyScalar(dist * .45)).add(new THREE.Vector3(0, dist * .75, 0));
    this.controls.autoRotate = false;
    this.fly = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: top.clone().setY(top.y * .6), t: 0, dur: 1.5 };
  }
  overview(dur = 1.8) {
    const r = R0 + (this.chain.n / PER_RING) * DR;
    this.fly = { from: this.camera.position.clone(), to: new THREE.Vector3(0, r * 1.5, r * 1.95), tFrom: this.controls.target.clone(), tTo: new THREE.Vector3(0, 0, 0), t: 0, dur };
  }
  /** a spiral of glowing dots above the selected block, one per transaction (capped) */
  showTxCloud(h: number, feeRange?: number[]) {
    const n = Math.min(this.chain.tx[h], 3000), top = this.topOf(h);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color();
    const fr = feeRange && feeRange.length ? feeRange : [1, 2, 4, 8, 16, 32, 64];
    const lo = Math.log(Math.max(1, fr[0])), hi = Math.log(Math.max(2, fr[fr.length - 1]));
    let seed = h * 9301 + 49297;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < n; i++) {
      const k = i / Math.max(1, n - 1), a = i * 2.39996, rr = .08 + .55 * Math.sqrt(k);
      pos[i * 3] = top.x + Math.cos(a) * rr; pos[i * 3 + 1] = top.y + .25 + k * .9 + (rnd() - .5) * .05; pos[i * 3 + 2] = top.z + Math.sin(a) * rr;
      // pick a fee rate by interpolating the block's fee percentiles
      const q = rnd() * (fr.length - 1), j = Math.floor(q), fee = fr[j] + (fr[Math.min(j + 1, fr.length - 1)] - fr[j]) * (q - j);
      const t = Math.min(1, Math.max(0, (Math.log(Math.max(1, fee)) - lo) / (hi - lo || 1)));
      c.setHSL(.07 + t * .06, .95, .35 + t * .4).multiplyScalar(1.6);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (this.cloud) { this.scene.remove(this.cloud); this.cloud.geometry.dispose(); }
    this.cloud = new THREE.Points(g, new THREE.PointsMaterial({ size: .035, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    this.cloudT = 0;
    this.scene.add(this.cloud);
  }

  playReveal() { this.reveal = 0; this.revealing = true; }

  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); this.labels.setSize(innerWidth, innerHeight);
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), .05), u = this.mat.uniforms;
    u.uTime.value += dt;
    if (u.uMix.value < 1) u.uMix.value = Math.min(1, u.uMix.value + dt * 1.6);
    if (this.revealing) {
      this.reveal += dt / 4.2;
      const k = this.reveal >= 1 ? 1 : 1 - Math.pow(1 - this.reveal, 2.2);
      u.uReveal.value = k * (this.chain.n + 9000);
      if (this.reveal >= 1) { this.revealing = false; u.uReveal.value = 1e9; }
    }
    if (this.fly) {
      const f = this.fly; f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < .5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.from, f.to, e);
      this.controls.target.lerpVectors(f.tFrom, f.tTo, e);
      if (f.t >= 1) this.fly = null;
    }
    if (this.cloud) {
      this.cloudT = Math.min(1, this.cloudT + dt * 1.5);
      (this.cloud.material as THREE.PointsMaterial).opacity = this.cloudT;
      this.cloud.rotation.y = 0;
    }
    this.controls.update();
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}

function hexRGB(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
