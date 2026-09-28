/**
 * All sound is synthesised with the Web Audio API: a slow ambient pad, glassy ticks as
 * transactions land in the next block, a bell-and-boom when a block is mined, and a whoosh
 * for long camera flights. Everything routes through one master bus so a clip recording
 * can capture it too.
 */
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const PENTA = [0, 3, 5, 7, 10];            // A minor pentatonic
const ROOT = 57;                            // A3

export class Sound {
  ctx: BaseAudioContext | null = null;
  /** when set, events are scheduled at this time instead of now (offline rendering) */
  at: number | null = null;
  private now() { return this.at ?? this.ctx!.currentTime; }
  on = false;
  master!: GainNode;
  private fx!: GainNode;
  private verb!: ConvolverNode;
  private noise!: AudioBuffer;
  private padFilter!: BiquadFilterNode;
  private lastTick = 0;
  private lastHover = 0;
  dest: MediaStreamAudioDestinationNode | null = null;

  start() {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return false;
    if (!this.ctx) this.build(new AC());
    (this.ctx as AudioContext).resume();
    this.on = true;
    const t = this.ctx!.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(.9, t, .8);
    return true;
  }
  stop() {
    this.on = false;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, .25);
  }

  build(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = .01;
    this.master.connect(comp).connect(ctx.destination);
    if ('createMediaStreamDestination' in ctx) { this.dest = (ctx as AudioContext).createMediaStreamDestination(); comp.connect(this.dest); }

    this.verb = ctx.createConvolver();
    const len = ctx.sampleRate * 4.5, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    this.verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = .55; this.verb.connect(wet).connect(this.master);
    this.fx = ctx.createGain(); this.fx.connect(this.master);
    const send = ctx.createGain(); send.gain.value = .6; this.fx.connect(send).connect(this.verb);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // ambient pad: A minor add9, detuned saws through a slowly breathing low-pass
    this.padFilter = ctx.createBiquadFilter(); this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 520; this.padFilter.Q.value = .7;
    const lfo = ctx.createOscillator(); lfo.frequency.value = .035;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 260; lfo.connect(lfoAmt).connect(this.padFilter.frequency); lfo.start();
    const pad = ctx.createGain(); pad.gain.value = .75;
    this.padFilter.connect(pad); pad.connect(this.master);
    const padSend = ctx.createGain(); padSend.gain.value = .9; pad.connect(padSend).connect(this.verb);
    [33, 45, 52, 57, 59, 64].forEach((m, i) => {
      const g = ctx.createGain(); g.gain.value = i < 2 ? .05 : .014;
      for (const det of i < 2 ? [0] : [-8, 7]) {
        const o = ctx.createOscillator(); o.type = i < 2 ? 'sine' : 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
        o.connect(g); o.start();
      }
      const trem = ctx.createOscillator(); trem.frequency.value = .03 + Math.random() * .07;
      const tg = ctx.createGain(); tg.gain.value = g.gain.value * .5; trem.connect(tg).connect(g.gain); trem.start();
      g.connect(this.padFilter);
    });
  }

  private env(g: GainNode, t: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(.0001, t + a + d);
  }
  private bell(freq: number, vel: number, when = 0, pan = 0) {
    const ctx = this.ctx!, t = this.now() + when;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(this.fx);
    for (const [r, a, d] of [[1, 1, 3.2], [2.76, .28, 1.3], [5.4, .09, .6], [8.9, .04, .3]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * r;
      const g = ctx.createGain(); this.env(g, t, .004, vel * a * .18, d);
      o.connect(g).connect(p); o.start(t); o.stop(t + d + .1);
    }
  }
  private note(k: number, oct = 1) { return mtof(ROOT + 12 * oct + PENTA[((k % 5) + 5) % 5] + 12 * Math.floor(k / 5)); }

  /** a transaction landing in the next block */
  tick() {
    if (!this.on) return;
    const now = this.now() * 1000; if (now - this.lastTick < 110 && now >= this.lastTick) return; this.lastTick = now;
    const ctx = this.ctx!, t = this.now();
    const f = this.note(Math.floor(Math.random() * 10), 2);
    const p = ctx.createStereoPanner(); p.pan.value = Math.random() * 1.4 - .7; p.connect(this.fx);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = ctx.createGain(); this.env(g, t, .002, .035, .35);
    o.connect(g).connect(p); o.start(t); o.stop(t + .5);
  }
  hover() {
    if (!this.on) return;
    const now = this.now() * 1000; if (now - this.lastHover < 60 && now >= this.lastHover) return; this.lastHover = now;
    const ctx = this.ctx!, t = this.now();
    const o = ctx.createOscillator(); o.frequency.value = 2400 + Math.random() * 600;
    const g = ctx.createGain(); this.env(g, t, .001, .012, .04);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + .06);
  }
  click() {
    if (!this.on) return;
    const ctx = this.ctx!, t = this.now();
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(1300, t); o.frequency.exponentialRampToValueAtTime(700, t + .05);
    const g = ctx.createGain(); this.env(g, t, .002, .05, .07);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + .1);
  }
  /** a new block joins the chain */
  blockFound() {
    if (!this.on) return;
    const ctx = this.ctx!, t = this.now();
    // sub boom
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(32, t + 1.2);
    const g = ctx.createGain(); this.env(g, t, .01, .55, 1.8);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 2);
    // shimmer
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(2000, t); f.frequency.exponentialRampToValueAtTime(9000, t + 1.4);
    const sg = ctx.createGain(); this.env(sg, t, .05, .06, 1.5);
    s.connect(f).connect(sg).connect(this.fx); s.start(t); s.stop(t + 1.7);
    // bell chord, rolled
    [0, 2, 4, 5, 7].forEach((k, i) => this.bell(this.note(k, 1), .9 - i * .08, i * .07, (i - 2) * .25));
  }
  /** a long camera flight; returns nothing, lasts `dur` seconds */
  whoosh(dur: number) {
    if (!this.on) return;
    const ctx = this.ctx!, t = this.now();
    const s = ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(220, t); f.frequency.exponentialRampToValueAtTime(2600, t + dur * .45); f.frequency.exponentialRampToValueAtTime(260, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.14, t + dur * .4); g.gain.exponentialRampToValueAtTime(.0001, t + dur + .3);
    s.connect(f).connect(g).connect(this.fx); s.start(t); s.stop(t + dur + .4);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(mtof(33), t); o.frequency.exponentialRampToValueAtTime(mtof(45), t + dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
    const og = ctx.createGain(); og.gain.setValueAtTime(.0001, t); og.gain.exponentialRampToValueAtTime(.05, t + dur * .7); og.gain.exponentialRampToValueAtTime(.0001, t + dur + .2);
    o.connect(lp).connect(og).connect(this.master); o.start(t); o.stop(t + dur + .3);
  }
  arrive() {
    if (!this.on) return;
    [0, 4, 7, 9].forEach((k, i) => this.bell(this.note(k, 1), .8, i * .11, (i - 1.5) * .3));
    const ctx = this.ctx!, t = this.now();
    const o = ctx.createOscillator(); o.frequency.value = mtof(33);
    const g = ctx.createGain(); this.env(g, t, .02, .2, 2.5); o.connect(g).connect(this.master); o.start(t); o.stop(t + 2.6);
  }
}

/** Render a logged sequence of sound events (seconds, method, args) with the site's own synth, as a 16-bit WAV. */
export async function renderEvents(events: [number, string, unknown[]][], seconds: number): Promise<Uint8Array> {
  const SR = 44100, ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const s = new Sound();
  s.build(ctx); s.on = true;
  s.master.gain.setValueAtTime(.9, 0);
  for (const [t, name, args] of events) { s.at = t; (s as any)[name](...args); }
  const buf = await ctx.startRendering();
  const n = buf.length, out = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, x: string) => { for (let i = 0; i < x.length; i++) out.setUint8(o + i, x.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, SR, true);
  out.setUint32(28, SR * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 4, true);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) for (const [c, ch] of [[0, L], [1, R]] as const) out.setInt16(44 + i * 4 + c * 2, Math.max(-1, Math.min(1, ch[i])) * 32767, true);
  return new Uint8Array(out.buffer);
}
