/**
 * Cylindrical waveguide synthesis worklet — v2.
 *
 * Open pipe  (flute/recorder): N = SR/f, coeff = +1 → all harmonics
 * Closed pipe (clarinet/oboe): N = SR/(2f), coeff = -1 → odd harmonics only
 *
 * Excitation: shaped noise burst seeded into delay line.
 * Decay: frequency-dependent (higher f decays faster, like real pipes).
 */
class WaveguideProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf    = null;
    this._ptr    = 0;
    this._N      = 0;
    this._active = false;
    this._coeff  = 1;
    this._decay  = 0.9995;
    this._excBuf = null;
    this._excPtr = 0;
    this.port.onmessage = ev => {
      if (ev.data.type === 'trigger') this._excite(ev.data);
    };
  }

  _excite({ frequency, velocity, closed = false }) {
    const f   = Math.max(20, Math.min(2000, +frequency || 220));
    const vel = Math.max(0.01, Math.min(2,  +velocity  || 0.6));

    // Delay length: open → full period, closed → half period + sign flip
    const N = Math.max(4, Math.round(closed ? sampleRate / f / 2 : sampleRate / f));
    this._N     = N;
    this._coeff = closed ? -1 : 1;   // -1 → odd harmonics (clarinet/oboe)
    // Higher freq = faster wall-loss decay
    this._decay = Math.max(0.9974, Math.min(0.9999, 0.9998 - f * 1.6e-7));

    // Seed delay line: sine for pitch-lock + noise for attack texture
    const buf = new Float32Array(N + 2);
    for (let i = 0; i < N; i++) {
      buf[i] = Math.sin(2 * Math.PI * i / N) * vel * 0.22
             + (Math.random() * 2 - 1) * vel * 0.30;
    }
    this._buf = buf;
    this._ptr = 0;
    this._active = true;

    // Breath excitation added sample-by-sample at the start
    const burstMs = closed ? 20 : 38;  // clarinet shorter, flute breathier
    const M = Math.round(sampleRate * burstMs / 1000);
    const exc = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const x = i / M;
      const env = closed
        ? Math.pow(Math.sin(Math.PI * x), 0.65)           // single-arch burst
        : (x < 0.22 ? x / 0.22 : Math.pow(1 - (x - 0.22) / 0.78, 1.3)); // slow rise
      exc[i] = (Math.random() * 2 - 1) * vel * env;
    }
    this._excBuf = exc;
    this._excPtr = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this._active || !this._buf) { out.fill(0); return true; }

    const N = this._N;
    const c = this._coeff;
    const d = this._decay;
    let energy = 0;

    for (let i = 0; i < out.length; i++) {
      const exc = this._excPtr < this._excBuf.length ? this._excBuf[this._excPtr++] : 0;
      const p  = this._ptr;
      const pn = p < N ? p + 1 : 0;

      out[i] = this._buf[p];
      energy += out[i] * out[i];

      // Karplus-Strong one-zero LP + reflection sign + breath excitation
      this._buf[p] = c * (this._buf[p] * 0.5 + this._buf[pn] * 0.5) * d + exc;
      this._ptr = pn;
    }

    if (this._excPtr >= this._excBuf.length && energy / out.length < 1e-9) {
      this._active = false;
    }
    return true;
  }
}

registerProcessor('waveguide', WaveguideProcessor);
