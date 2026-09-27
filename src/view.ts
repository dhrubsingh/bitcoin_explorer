import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Chain, Metric, fmtInt, metricValue } from './data';

/*
 * The chain lies along one Archimedean spiral: genesis near the centre, the newest block on the
 * outside. Near the tip the curve is so gentle it reads as a straight chain; zoomed out, the whole
 * history is a coil. Positions are computed in float64 on the CPU and handed to the GPU in a
 * texture, so blocks stay aligned ~1,500 units from the origin.
 */
const TEX_W = 2048;
const PITCH = 4.5;               // distance between loops of the coil
const STEP = 1.75;               // distance between consecutive blocks
const B = PITCH / (2 * Math.PI);
const THETA0 = 6 * Math.PI;
const L0 = B * THETA0 * THETA0 / 2;
const TAU = Math.PI * 2;
const LINK_WINDOW = 6000;        // links drawn around the camera focus
const NEAR_WINDOW = 3000;        // reflections drawn around the camera focus
const MOTE_BLOCKS = 72, MOTES_PER = 48;

export const POOL_COLORS = ['#3A3E4A', '#F7931A', '#5FD4C4', '#A78BFA', '#60A5FA', '#F4D35E', '#F472B6', '#34D399', '#FB7185', '#93C5FD', '#FDBA74', '#86EFAC', '#C4B5FD', '#FCA5A5', '#67E8F9', '#D9F99D'];
export const poolColor = (i: number) => (i === 0 ? POOL_COLORS[0] : POOL_COLORS[1 + ((i - 1) % 15)]);

const tf: Record<Metric, (v: number) => number> = {
  tx: v => Math.log1p(v), pool: v => Math.log1p(v), fees: v => Math.log10(1 + v * 1e5), size: v => Math.log1p(v * 8), interval: v => Math.log1p(v), price: v => Math.log10(1 + v),
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
}
ivec2 cell(int id) { return ivec2(id % ${TEX_W}, id / ${TEX_W}); }`;

const blockVert = /* glsl */ `
uniform sampler2D uData, uPos;
uniform float uMix, uCut, uReveal, uHover, uSel, uNewest, uTime, uPools, uFocus, uFar, uWaveT, uStart;
uniform vec3 uPal[16];
out vec3 vCol; out vec3 vLocal; out vec3 vN; out float vDim; out vec3 vWorld;
${common}
void main() {
#ifdef REFLECT
  int id = int(uStart) + gl_InstanceID;
#else
  int id = gl_InstanceID;
#endif
  float fid = float(id);
  vec4 d = texelFetch(uData, cell(id), 0), p = texelFetch(uPos, cell(id), 0);
  float t = mix(d.g, d.r, uMix);
  float lim = min(min(uCut, uReveal), uNewest);
  bool hov = abs(fid - uHover) < .5, sel = abs(fid - uSel) < .5, newest = abs(fid - uNewest) < .5;
  float grow = clamp((min(uCut, uReveal) - fid) / 14000., 0., 1.);
  float away = smoothstep(250., 1400., abs(fid - uFocus)) * (1. - uFar);
  float sz = mix(.42, 1.2, t) * grow * (sel ? 1.2 : 1.) * mix(1., .07, away);
  if (fid > lim) sz = 0.;
  if (newest && uWaveT < 1.2) sz *= 1. + .25 * sin(min(uWaveT, 1.) * 3.14159);   // a newly mined block pops in
  vec3 tang = vec3(cos(p.z), 0., sin(p.z)), nrm = vec3(-sin(p.z), 0., cos(p.z));
  vec3 lp = position * sz;
  vec3 wp = vec3(p.x, sz * .5, p.y) + tang * lp.x + nrm * lp.z + vec3(0., lp.y, 0.);
  vLocal = position;
  vN = normal.x * tang + vec3(0., normal.y, 0.) + normal.z * nrm;
  vec3 c;
  if (uPools > .5) { int pi = int(d.b + .5); c = lin(pi == 0 ? uPal[0] : uPal[1 + (pi - 1) % 15]) * (pi == 0 ? .8 : 1.1); }
  else c = ember(t);
  if (newest) c *= 1.4 + .5 * sin(uTime * 2.4);
  float wave = (uNewest - fid) - uWaveT * 55.;                    // shockwave running down the chain
  c *= 1. + 2.2 * exp(-wave * wave / 30.) * exp(-uWaveT * .45);
  if (hov) c = c * 1.6 + vec3(.15);
  if (sel) c = lin(vec3(1., .95, .85)) * 1.6;
  vDim = mix(1., .25, away) * ((uSel > -.5 && !sel) ? .55 : 1.);
  vCol = c;
#ifdef REFLECT
  wp.y = -wp.y; vN.y = -vN.y;
#endif
  vWorld = wp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.);
}`;
const blockFrag = /* glsl */ `
uniform float uFar;
in vec3 vCol; in vec3 vLocal; in vec3 vN; in float vDim; in vec3 vWorld;
out vec4 fragColor;
void main() {
  vec3 a = abs(vLocal);
  float mx = max(a.x, max(a.y, a.z)), mn = min(a.x, min(a.y, a.z));
  float e = .5 - (a.x + a.y + a.z - mx - mn);               // distance to this face's nearest edge
  float w = fwidth(e);
  float close = 1. - uFar;
  float edge = (1. - smoothstep(.028, .028 + w * 1.5 + .003, e)) * close;
  vec3 n = normalize(vN), v = normalize(cameraPosition - vWorld);
  float rim = pow(1. - abs(dot(n, v)), 3.) * close;           // glassy fresnel
  float l = .55 + .45 * max(dot(n, normalize(vec3(.3, 1., .2))), 0.);
  vec3 c = vCol * mix(.1, .8, uFar) * l + vCol * edge * 1.05 + vCol * rim * .55;
#ifdef REFLECT
  c *= .3 * smoothstep(-1.5, 0., vWorld.y);
#endif
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
  vec3 wp = mid + tang * position.x * len + nrm * position.z * .06 + vec3(0., position.y * .06, 0.);
  if (float(j) > uLim || j < 1 || (abs(float(j) - uFocus) > 1300. && uFar < .5)) wp = vec3(0., -9999., 0.);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.);
}`;
const linkFrag = /* glsl */ `
uniform float uFar; out vec4 fragColor;
void main() { fragColor = vec4(vec3(1., .42, .06) * 1.2 * (1. - uFar), 1.); }`;

/* transactions floating inside the blocks near the camera */
const moteVert = /* glsl */ `
uniform sampler2D uData, uPos;
uniform float uBase, uTime, uNewest, uFill, uLim, uScale;
in vec4 aOff;       // xyz: position inside the unit cube, w: index within the block
in float aSlot;
out float vA;
${common}
void main() {
  int id = int(uBase + aSlot);
  float fid = float(id);
  bool pending = fid > uNewest + .5;
  vec4 d = texelFetch(uData, cell(id), 0), p = texelFetch(uPos, cell(id), 0);
  float txn = pending ? uFill : d.a;
  float sz = pending ? 1.2 * .9 : mix(.42, 1.2, d.r);
  float show = step(aOff.w, txn * ${MOTES_PER}.) * step(fid, uLim + (pending ? 1. : 0.));
  vec3 tang = vec3(cos(p.z), 0., sin(p.z)), nrm = vec3(-sin(p.z), 0., cos(p.z));
  vec3 o = aOff.xyz + .06 * vec3(sin(uTime * .7 + aOff.w), sin(uTime * .9 + aOff.w * 1.7), cos(uTime * .6 + aOff.w * 2.3));
  o = clamp(o, -.42, .42) * sz;
  vec3 wp = vec3(p.x, (pending ? .6 * 1.2 : sz * .5), p.y) + tang * o.x + nrm * o.z + vec3(0., o.y, 0.);
  vec4 mv = modelViewMatrix * vec4(wp, 1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = show * uScale * (.9 + .6 * fract(aOff.w * .37)) / -mv.z;
  vA = show * (.55 + .45 * sin(uTime * 2. + aOff.w));
}`;
const moteFrag = /* glsl */ `
uniform float uFar;
in float vA; out vec4 fragColor;
void main() {
  vec2 q = gl_PointCoord - .5; float r = dot(q, q);
  float a = exp(-r * 18.) * vA * (1. - uFar);
  fragColor = vec4(vec3(1., .78, .45) * 2. * a, a);
}`;

/* film grain + vignette, applied after tone mapping */
const GrainShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 q = vUv - .5;
      float vig = smoothstep(.95, .25, length(q * vec2(1.1, 1.)));
      c.rgb *= mix(.55, 1., vig);
      c.rgb += (h(vUv * 1000.) - .5) * .035;
      gl_FragColor = c; }`,
};

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
const ease = (t: number) => (t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

type Fly = { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number; dur: number; lift: number; done?: () => void; snappy?: boolean };
const easeOut = (t: number) => 1 - (1 - t) ** 3;

export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  labels: CSS2DRenderer;
  mat: THREE.ShaderMaterial;
  reflMat: THREE.ShaderMaterial;
  linkMat: THREE.ShaderMaterial;
  moteMat: THREE.ShaderMaterial;
  floorMat: THREE.ShaderMaterial;
  grain: ShaderPass;
  geo: THREE.InstancedBufferGeometry;
  refl: THREE.Mesh;
  data: Float32Array; dataTex: THREE.DataTexture;
  px: Float64Array; pz: Float64Array;
  t: Float32Array;
  txRange: [number, number] = [0, 1];
  metric: Metric = 'tx';
  range: [number, number] = [0, 1];
  fly: Fly | null = null;
  follow = true;
  reveal = 1; revealing = false;
  clock = new THREE.Clock();
  far = 0;
  idle = 0;
  drift: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  floor: THREE.Mesh;
  pending = new THREE.Group(); pendingLabel: CSS2DObject; pendingAt = new THREE.Vector3();
  fill = 0; fillTarget = .5; txRate = 4;
  sparks: THREE.Points; sparkState: { t: number; sp: number; from: THREE.Vector3 }[] = [];
  dust: THREE.Points;
  flash: THREE.Sprite; shock: THREE.Mesh;
  tipLabels: CSS2DObject[] = [];
  cloud: THREE.Points | null = null; cloudT = 0;
  onUserMove: () => void = () => {};
  onTxLand: () => void = () => {};
  onAfterRender: (() => void) | null = null;
  shotting = false;

  constructor(canvas: HTMLCanvasElement, labelsEl: HTMLElement, public chain: Chain) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color('#04050A');
    this.scene.fog = new THREE.FogExp2('#04050A', .01);

    this.camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, .05, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: .08, zoomToCursor: true, maxPolarAngle: 1.42, minDistance: 1.5, maxDistance: 9000, rotateSpeed: .55, zoomSpeed: 1.2 });
    this.controls.addEventListener('start', () => { this.fly = null; this.follow = false; this.drift = null; this.idle = 0; this.onUserMove(); });

    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), .6, .5, .8));
    this.composer.addPass(new OutputPass());
    this.grain = new ShaderPass(GrainShader);
    this.composer.addPass(this.grain);
    this.labels = new CSS2DRenderer({ element: labelsEl });
    this.labels.setSize(innerWidth, innerHeight);

    // textures: per-block data (metric now, metric before, pool, tx) + spiral positions
    const rows = Math.ceil((chain.cap + 2) / TEX_W);
    this.data = new Float32Array(TEX_W * rows * 4);
    this.dataTex = new THREE.DataTexture(this.data, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    const pos = new Float32Array(TEX_W * rows * 4);
    const posTex = new THREE.DataTexture(pos, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    for (const tx of [this.dataTex, posTex]) tx.minFilter = tx.magFilter = THREE.NearestFilter;
    this.px = new Float64Array(chain.cap + 2); this.pz = new Float64Array(chain.cap + 2);
    for (let i = 0; i <= chain.cap + 1; i++) {
      const p = blockPos(i); this.px[i] = p.x; this.pz[i] = p.z;
      pos[i * 4] = p.x; pos[i * 4 + 1] = p.z; pos[i * 4 + 2] = p.phi;
    }
    posTex.needsUpdate = true;
    this.t = new Float32Array(chain.cap);

    const uniforms = {
      uData: { value: this.dataTex }, uPos: { value: posTex }, uMix: { value: 1 }, uCut: { value: 1e9 }, uReveal: { value: 1e9 },
      uHover: { value: -1 }, uSel: { value: -1 }, uNewest: { value: -1 }, uTime: { value: 0 }, uPools: { value: 0 }, uFar: { value: 0 },
      uFocus: { value: 0 }, uWaveT: { value: 99 }, uStart: { value: 0 },
      uPal: { value: POOL_COLORS.map(c => new THREE.Vector3(...hexRGB(c))) },
    };
    this.mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: blockVert, fragmentShader: blockFrag, uniforms });
    this.reflMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: blockVert, fragmentShader: blockFrag, defines: { REFLECT: '' }, uniforms: { ...uniforms, uStart: { value: 0 } } });
    this.geo = cube();
    const blocks = new THREE.Mesh(this.geo, this.mat); blocks.frustumCulled = false;
    const reflGeo = cube(); reflGeo.instanceCount = NEAR_WINDOW;
    this.refl = new THREE.Mesh(reflGeo, this.reflMat); this.refl.frustumCulled = false; this.refl.renderOrder = -2;

    this.linkMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: linkVert, fragmentShader: linkFrag,
      uniforms: { uPos: { value: posTex }, uStart: { value: 1 }, uLim: { value: 1e9 }, uFar: uniforms.uFar, uFocus: uniforms.uFocus },
    });
    const linkGeo = cube(); linkGeo.instanceCount = LINK_WINDOW;
    const links = new THREE.Mesh(linkGeo, this.linkMat); links.frustumCulled = false;

    // motes: MOTE_BLOCKS consecutive blocks × MOTES_PER points each
    const mg = new THREE.BufferGeometry(), N = MOTE_BLOCKS * MOTES_PER;
    const off = new Float32Array(N * 4), slot = new Float32Array(N);
    for (let s = 0; s < MOTE_BLOCKS; s++) for (let k = 0; k < MOTES_PER; k++) {
      const i = s * MOTES_PER + k;
      off[i * 4] = Math.random() - .5; off[i * 4 + 1] = Math.random() - .5; off[i * 4 + 2] = Math.random() - .5; off[i * 4 + 3] = k;
      slot[i] = s;
    }
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    mg.setAttribute('aOff', new THREE.BufferAttribute(off, 4));
    mg.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
    this.moteMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: moteVert, fragmentShader: moteFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uData: uniforms.uData, uPos: uniforms.uPos, uBase: { value: 0 }, uTime: uniforms.uTime, uNewest: uniforms.uNewest, uFill: { value: .5 }, uLim: { value: 1e9 }, uScale: { value: 60 }, uFar: uniforms.uFar },
    });
    const motes = new THREE.Points(mg, this.moteMat); motes.frustumCulled = false;

    // glossy floor: tints the reflection and adds a faint grid near the chain
    this.floorMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uFocus: { value: new THREE.Vector2() }, uFar: uniforms.uFar, uR: { value: 1000 } },
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `uniform vec2 uFocus; uniform float uFar, uR; varying vec3 vW;
        void main(){
          vec2 p = vW.xz; float dF = length(p - uFocus), r = length(p) / uR;
          vec2 g = abs(fract(p / 1.75) - .5); vec2 fw = fwidth(p / 1.75);
          float line = max(1. - smoothstep(0., fw.x * 1.2, g.x), 1. - smoothstep(0., fw.y * 1.2, g.y));
          float near = exp(-dF * dF / 900.) * (1. - uFar);
          vec3 c = vec3(.012, .011, .016) + vec3(.9, .45, .12) * line * .05 * near;
          float a = mix(.62, .9, uFar) * smoothstep(1.15, .2, r);
          gl_FragColor = vec4(c, max(a, near * .62)); }`,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2; this.floor.position.y = -.005; this.floor.renderOrder = -1;
    this.scene.add(this.refl, this.floor, blocks, links, motes);

    // the next block, being assembled from waiting transactions
    const edgeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, .5, .1).multiplyScalar(1.4), toneMapped: false });
    const beam = new THREE.BoxGeometry(1, 1, 1);
    for (const a of [-.5, .5]) for (const b of [-.5, .5]) {
      for (const [p, s] of [[[0, a, b], [1.03, .022, .022]], [[a, 0, b], [.022, 1.03, .022]], [[a, b, 0], [.022, .022, 1.03]]] as [number[], number[]][]) {
        const m = new THREE.Mesh(beam, edgeMat); m.position.set(p[0], p[1], p[2]); m.scale.set(s[0], s[1], s[2]); this.pending.add(m);
      }
    }
    this.pending.add(new THREE.Mesh(new THREE.BoxGeometry(.98, .98, .98), new THREE.MeshBasicMaterial({ color: new THREE.Color(.9, .45, .1), transparent: true, opacity: .07, depthWrite: false })));
    const pl = document.createElement('div'); pl.className = 'pending-lbl';
    this.pendingLabel = new CSS2DObject(pl); this.pendingLabel.position.set(0, 1.75, 0); this.pending.add(this.pendingLabel);
    this.pending.scale.setScalar(1.2);
    this.scene.add(this.pending);
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(300 * 3), 3));
    this.sparks = new THREE.Points(sg, new THREE.PointsMaterial({ size: .12, map: GLOW, color: new THREE.Color(1, .6, .2).multiplyScalar(2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.sparks.frustumCulled = false;
    for (let i = 0; i < 300; i++) this.sparkState.push({ t: 1 + Math.random(), sp: 1, from: new THREE.Vector3() });
    this.scene.add(this.sparks);

    // floating dust around the camera focus
    const dp = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) { dp[i * 3] = (Math.random() - .5) * 60; dp[i * 3 + 1] = Math.random() * 14; dp[i * 3 + 2] = (Math.random() - .5) * 60; }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ size: .06, map: GLOW, color: new THREE.Color(1, .75, .5), transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);

    // new-block flash + shockwave ring on the floor
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: new THREE.Color(1, .7, .35).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.shock = new THREE.Mesh(new THREE.RingGeometry(.96, 1, 128), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, .55, .15).multiplyScalar(2.5), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    this.shock.rotation.x = -Math.PI / 2;
    this.flash.visible = this.shock.visible = false;
    this.scene.add(this.flash, this.shock);

    for (let k = 0; k < 7; k++) {
      const el = document.createElement('div'); el.className = 'tip-lbl';
      const o = new CSS2DObject(el); o.userData.h = -1; this.tipLabels.push(o); this.scene.add(o);
    }

    this.txRange = this.computeRange('tx');
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
  norm(h: number, m: Metric, r: [number, number]) {
    const k = m === 'pool' ? 'tx' : m;
    return Math.min(1, Math.max(0, (tf[k](metricValue(this.chain, k, h)) - r[0]) / (r[1] - r[0] || 1)));
  }
  setMetric(m: Metric, animate = true) {
    this.metric = m;
    this.range = this.computeRange(m === 'pool' ? 'tx' : m);
    const d = this.data, c = this.chain;
    for (let h = 0; h < c.n; h++) {
      const o = h * 4, v = this.norm(h, m, this.range);
      d[o + 1] = animate ? d[o] : v; d[o] = v; d[o + 2] = c.pool[h]; d[o + 3] = this.norm(h, 'tx', this.txRange); this.t[h] = v;
    }
    this.dataTex.needsUpdate = true;
    this.mat.uniforms.uPools.value = m === 'pool' ? 1 : 0;
    this.mat.uniforms.uMix.value = animate ? 0 : 1;
    this.tipLabels.forEach(l => (l.userData.h = -1));
  }
  writeBlock(h: number) {
    const o = h * 4, v = this.norm(h, this.metric, this.range);
    this.data[o] = this.data[o + 1] = v; this.data[o + 2] = this.chain.pool[h]; this.data[o + 3] = this.norm(h, 'tx', this.txRange); this.t[h] = v;
    this.dataTex.needsUpdate = true;
  }
  syncCount() {
    const n = this.chain.n;
    this.geo.instanceCount = n;
    this.mat.uniforms.uNewest.value = n - 1;
    this.linkMat.uniforms.uLim.value = Math.min(n - 1, this.mat.uniforms.uCut.value);
    const R = this.radius() + 25;
    this.floor.scale.set(R * 2.6, R * 2.6, 1);
    this.floorMat.uniforms.uR.value = R;
  }
  /** a freshly mined block: flash, a shockwave down the chain, a pop-in */
  celebrate() {
    this.mat.uniforms.uWaveT.value = 0; this.flashT = 0;
    const p = this.centerOf(this.chain.n - 1);
    this.flash.position.copy(p); this.shock.position.set(p.x, .01, p.z);
    this.flash.visible = this.shock.visible = true;
  }
  /** the same flash + ring, centred on any block (used when a journey lands) */
  celebrateAt(h: number) {
    const p = this.centerOf(h);
    this.flashT = 0; this.flash.position.copy(p); this.shock.position.set(p.x, .01, p.z);
    this.flash.visible = this.shock.visible = true;
  }
  flashT = 99;
  radius() { const p = blockPos(this.chain.n); return Math.hypot(p.x, p.z); }

  /* ---------- geometry ---------- */
  sizeOf(h: number) { return (.42 + (1.2 - .42) * this.t[h]) * (h === this.mat.uniforms.uSel.value ? 1.2 : 1); }
  centerOf(h: number) { return new THREE.Vector3(this.px[h], this.sizeOf(h) / 2, this.pz[h]); }
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
    const portrait = innerWidth / innerHeight < 1;
    const n = this.chain.n, p = blockPos(Math.max(0, n - (portrait ? .4 : 4)));
    const dir = new THREE.Vector3(Math.cos(p.phi), 0, Math.sin(p.phi)), out = new THREE.Vector3(p.x, 0, p.z).normalize();
    const target = new THREE.Vector3(p.x, .5, p.z).addScaledVector(dir, -1.5);
    const back = portrait ? 22 : 16;
    const cam = target.clone().addScaledVector(out, back).addScaledVector(dir, -4).add(new THREE.Vector3(0, back * .36, 0));
    return { cam, target };
  }
  blockFrame(h: number, dist = 7) {
    const c = this.centerOf(h), p = blockPos(h);
    const dir = new THREE.Vector3(Math.cos(p.phi), 0, Math.sin(p.phi)), out = new THREE.Vector3(p.x, 0, p.z).normalize();
    return { cam: c.clone().addScaledVector(out, dist).addScaledVector(dir, -dist * .35).add(new THREE.Vector3(0, dist * .5, 0)), target: c.clone().setY(c.y + .5) };
  }
  goLive(dur = 1.6) { this.follow = true; const { cam, target } = this.liveFrame(); this.flyTo(cam, target, dur); }
  overview(dur = 2.2) {
    this.follow = false;
    const R = this.radius();
    this.flyTo(new THREE.Vector3(0, R * 2.3, R * 1.3), new THREE.Vector3(0, 0, 0), dur);
  }
  /** stepping to a neighbouring block: slide the current view along the chain, keeping the camera angle */
  stepTo(h: number) {
    this.follow = false;
    const c = this.centerOf(h), to = new THREE.Vector3(c.x, c.y + .5, c.z);
    const delta = to.clone().sub(this.fly ? this.fly.tTo : this.controls.target);
    const camTo = (this.fly ? this.fly.to : this.camera.position).clone().add(delta);
    this.flyTo(camTo, to, .32);
    this.fly!.snappy = true;
  }
  focusBlock(h: number, dur?: number) {
    this.follow = false; const { cam, target } = this.blockFrame(h);
    // long hops arc up over the coil instead of cutting through other blocks
    const hop = this.controls.target.distanceTo(target);
    this.flyTo(cam, target, dur ?? Math.min(3.4, 1.4 + this.far * 1.4 + Math.log10(1 + hop) * .45), Math.min(hop * .35, 260) + (this.far > .5 ? 25 : 0));
  }
  flyTo(to: THREE.Vector3, target: THREE.Vector3, dur: number, lift = 0, done?: () => void) {
    this.drift = null; this.idle = 0;
    this.fly = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: target, t: 0, dur, lift, done };
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
  /** event markers: a thin beam of light over each event block plus a label */
  setEvents(list: { h: number; name: string; kind: string; major?: boolean }[]) {
    const colors: Record<string, THREE.Color> = { protocol: new THREE.Color(.37, .83, .77), market: new THREE.Color(1, .6, .15), world: new THREE.Color(.66, .55, 1) };
    const beam = new THREE.BoxGeometry(1, 1, 1);
    for (const e of list) {
      if (e.h < 0 || e.h >= this.chain.n) continue;
      const col = colors[e.kind] ?? colors.protocol;
      const m = new THREE.Mesh(beam, new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.4), transparent: true, opacity: .45, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      m.scale.set(.018, 2.2, .018);
      m.position.set(this.px[e.h], this.sizeOf(e.h) + 1.25, this.pz[e.h]);
      this.scene.add(m);
      const el = document.createElement('div'); el.className = `ev-lbl ${e.kind}`; el.textContent = e.name;
      const o = new CSS2DObject(el); o.position.set(this.px[e.h], this.sizeOf(e.h) + 2.7, this.pz[e.h]);
      o.userData = { h: e.h, major: !!e.major, beam: m };
      this.events.push(o); this.scene.add(o);
    }
  }
  events: CSS2DObject[] = [];

  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); this.labels.setSize(innerWidth, innerHeight);
  }

  frame(fixedDt?: number) {
    const real = this.clock.getDelta();
    const dt = fixedDt ?? Math.min(real, .05), u = this.mat.uniforms, n = this.chain.n;
    u.uTime.value += dt; this.grain.uniforms.uTime.value = u.uTime.value % 10;
    u.uWaveT.value = Math.min(99, u.uWaveT.value + dt);
    if (u.uMix.value < 1) u.uMix.value = Math.min(1, u.uMix.value + dt * 1.6);
    if (this.revealing) {
      this.reveal = Math.min(1, this.reveal + dt / 5);
      const k = 1 - Math.pow(1 - this.reveal, 2.4);
      u.uReveal.value = this.reveal >= 1 ? 1e9 : k * (n + 14000);
      if (this.reveal >= 1) this.revealing = false;
    }
    this.idle += dt;
    if (this.fly) {
      const f = this.fly; f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.snappy ? easeOut(f.t) : ease(f.t);
      this.camera.position.lerpVectors(f.from, f.to, e);
      this.camera.position.y += Math.sin(Math.PI * e) * f.lift;
      this.controls.target.lerpVectors(f.tFrom, f.tTo, f.snappy ? e : ease(Math.min(1, f.t * 1.08)));
      if (f.t >= 1) {
        this.fly = null; this.idle = 0;
        this.drift = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
        f.done?.();
      }
    } else if (this.drift && this.idle > 4 && !this.shotting) {
      // idle: a slow cinematic sway around the resting pose
      const k = Math.min(1, (this.idle - 4) / 3), tt = this.idle - 4;
      const off = this.drift.pos.clone().sub(this.drift.target);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(tt * .09) * .32 * k);
      this.camera.position.copy(this.drift.target).add(off).add(new THREE.Vector3(0, Math.sin(tt * .13) * .8 * k, 0));
      this.controls.target.copy(this.drift.target);
    }
    this.controls.update();

    const dist = this.camera.position.distanceTo(this.controls.target);
    this.far = THREE.MathUtils.smoothstep(dist, 30, 260);
    u.uFar.value = this.far;
    (this.scene.fog as THREE.FogExp2).density = .42 / Math.max(10, dist);
    this.camera.near = Math.max(.05, dist * .004); this.camera.far = dist * 30 + 300; this.camera.updateProjectionMatrix();

    const focusRaw = this.nearest(this.controls.target.x, this.controls.target.z, n - 1).i;
    const focus = focusRaw < 0 ? n : focusRaw;
    u.uFocus.value = focus;
    this.linkMat.uniforms.uStart.value = Math.max(1, Math.min(n - LINK_WINDOW + 1, focus - LINK_WINDOW / 2));
    this.reflMat.uniforms.uStart.value = Math.max(0, Math.min(n - NEAR_WINDOW, focus - NEAR_WINDOW / 2));
    this.refl.visible = this.far < .7;
    this.floorMat.uniforms.uFocus.value.set(this.controls.target.x, this.controls.target.z);
    const cut = u.uCut.value;
    this.moteMat.uniforms.uBase.value = Math.max(0, Math.min(n + 1 - MOTE_BLOCKS, focus - MOTE_BLOCKS / 2));
    this.moteMat.uniforms.uLim.value = Math.min(cut, n - 1);
    this.moteMat.uniforms.uScale.value = 55 * this.renderer.getPixelRatio() * innerHeight / 900;

    // next block + incoming transactions
    const pp = blockPos(n), target = new THREE.Vector3(pp.x, .6 * 1.2, pp.z);
    if (this.pendingAt.lengthSq() === 0) this.pendingAt.copy(target);
    this.pendingAt.lerp(target, 1 - Math.exp(-dt * 4));
    this.pending.position.copy(this.pendingAt);
    this.pending.rotation.y = -pp.phi;
    this.pending.visible = cut >= n - 1 && !this.revealing && this.far < .95;
    this.fill += (this.fillTarget - this.fill) * (1 - Math.exp(-dt * 2));
    this.moteMat.uniforms.uFill.value = this.fill;
    const sp = this.sparks.geometry.attributes.position.array as Float32Array;
    let spawn = this.txRate * dt;
    this.sparkState.forEach((s, i) => {
      if (s.t >= 1 && spawn > Math.random() && this.pending.visible) {
        spawn -= 1; s.t = 0; s.sp = .5 + Math.random() * .5;
        s.from.set((Math.random() - .5) * 16, 1.5 + Math.random() * 7, (Math.random() - .5) * 16).add(this.pendingAt);
      }
      if (s.t < 1) {
        s.t += dt * s.sp * .7;
        if (s.t >= 1 && this.far < .5) this.onTxLand();
        const e = s.t * s.t;
        sp[i * 3] = s.from.x + (this.pendingAt.x - s.from.x) * e; sp[i * 3 + 1] = s.from.y + (this.pendingAt.y - s.from.y) * e; sp[i * 3 + 2] = s.from.z + (this.pendingAt.z - s.from.z) * e;
      } else sp[i * 3 + 1] = -9999;
    });
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.visible = this.pending.visible;

    // dust follows the focus; new-block flash + shockwave
    this.dust.position.set(this.controls.target.x, 0, this.controls.target.z);
    this.dust.rotation.y = u.uTime.value * .01;
    (this.dust.material as THREE.PointsMaterial).opacity = .45 * (1 - this.far);
    this.flashT = Math.min(99, this.flashT + dt);
    const w = this.flashT;
    if (this.flash.visible) {
      const k = Math.min(1, w / 1.4);
      this.flash.scale.setScalar(2 + k * 10); (this.flash.material as THREE.SpriteMaterial).opacity = (1 - k) ** 2;
      this.shock.scale.setScalar(.5 + w * 22); (this.shock.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - w / 2.2);
      if (w > 2.2) this.flash.visible = this.shock.visible = false;
    }

    const close = this.far < .25;
    this.tipLabels.forEach((l, k) => {
      const h = n - 1 - k;
      l.visible = close && h >= 0 && h <= cut && !this.revealing;
      if (!l.visible) return;
      if (l.userData.h !== h) { l.userData.h = h; l.element.innerHTML = `<b>#${fmtInt(h)}</b><span>${fmtInt(this.chain.tx[h])} tx</span>`; }
      l.position.set(this.px[h], this.sizeOf(h) + .7, this.pz[h]);
    });
    // event labels: the big ones from afar, every one when it is near the stretch you are looking at
    const shown = Math.min(cut, u.uReveal.value);
    this.events.forEach(o => {
      const h = o.userData.h, near = Math.abs(h - focus) < 40;
      o.visible = h <= shown && (this.far > .6 ? o.userData.major : this.far < .3 && near);
      o.userData.beam.visible = h <= shown && this.far < .5 && Math.abs(h - focus) < 400;
      if (o.visible && this.far > .6) o.position.y = 1.4; else o.position.y = this.sizeOf(h) + 2.7;
    });
    if (this.cloud) { this.cloudT = Math.min(1, this.cloudT + dt * 1.5); (this.cloud.material as THREE.PointsMaterial).opacity = this.cloudT; }

    this.composer.render();
    this.onAfterRender?.();
    this.labels.render(this.scene, this.camera);
  }
}
