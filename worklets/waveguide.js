/**
 * Cylindrical waveguide synthesis worklet — v3 (sustained wind model).
 *
 * Open pipe  (flute/recorder): N = SR/f, coeff = +1 → all harmonics
 * Closed pipe (clarinet/oboe): N = SR/(2f), coeff = -1 → odd harmonics only
 *
 * Key difference from v2: excitation is sustained for the full note duration
 * (breath noise injected in-process), so the pipe resonates like a real wind
 * instrument rather than a plucked string.
 */
class WaveguideProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf    = null;
    this._ptr    = 0;
    this._N      = 0;
    this._active = false;
    this._coeff  = 1;
    this._decay  = 0.9999;
    // initial burst
    this._excBuf = null;
    this._excPtr = 0;
    // sustained breath state
    this._sustainAmp     = 0;
    this._attackSamples  = 0;
    this._sustainSamples = 0;
    this._totalSamples   = 0;

    this.port.onmessage = ev => {
      if (ev.data.type === 'trigger') this._excite(ev.data);
    };
  }

  _excite({ frequency, velocity, closed = false, duration = 1.5 }) {
    const f   = Math.max(20, Math.min(15000, +frequency || 220));
    const vel = Math.max(0.01, Math.min(2,   +velocity  || 0.6));
    const dur = Math.max(0.05, Math.min(8,   +duration  || 1.5));

    // Delay length: open → full period, closed → half period
    const N = Math.max(4, Math.round(closed ? sampleRate / f / 2 : sampleRate / f));
    this._N     = N;
    this._coeff = closed ? -1 : 1;

    // Wind: very slow wall-loss decay — resonator sustained by continuous breath
    // (much closer to 1.0 than v2's string model)
    this._decay = Math.max(0.9990, Math.min(0.99999, 0.99998 - f * 2e-8));

    // Seed delay line: sine for immediate pitch-lock + initial noise
    const buf = new Float32Array(N + 2);
    for (let i = 0; i < N; i++) {
      buf[i] = Math.sin(2 * Math.PI * i / N) * vel * 0.30
             + (Math.random() * 2 - 1) * vel * 0.20;
    }
    this._buf = buf;
    this._ptr = 0;
    this._active = true;

    // Short initial burst (attack transient — tongue/embouchure onset)
    const burstMs = closed ? 18 : 35;
    const M = Math.round(sampleRate * burstMs / 1000);
    const exc = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const x = i / M;
      const env = closed
        ? Math.pow(Math.sin(Math.PI * x), 0.5)
        : (x < 0.20 ? x / 0.20 : Math.pow(1 - (x - 0.20) / 0.80, 1.2));
      exc[i] = (Math.random() * 2 - 1) * vel * env;
    }
    this._excBuf = exc;
    this._excPtr = 0;

    // Sustained breath noise parameters (computed in process() — no giant buffer)
    //   flute:    breathy, higher amplitude noise
    //   clarinet: drier, reedy — less continuous noise
    this._sustainAmp     = closed ? vel * 0.055 : vel * 0.13;
    this._attackSamples  = Math.round(sampleRate * (closed ? 0.025 : 0.075));
    this._sustainSamples = Math.round(sampleRate * dur);
    this._totalSamples   = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this._active || !this._buf) { out.fill(0); return true; }

    const N   = this._N;
    const c   = this._coeff;
    const d   = this._decay;
    const ss  = this._sustainSamples;
    const atk = this._attackSamples;
    const rel = Math.max(1, Math.round(ss * 0.08)); // 8% release
    let energy = 0;

    for (let i = 0; i < out.length; i++) {
      this._totalSamples++;
      const ts = this._totalSamples;

      // Initial burst
      let exc = this._excPtr < this._excBuf.length
        ? this._excBuf[this._excPtr++]
        : 0;

      // Sustained breath noise with attack/sustain/release envelope
      if (ts < ss) {
        let env;
        if (ts < atk) {
          env = ts / atk;
        } else if (ts > ss - rel) {
          env = Math.max(0, (ss - ts) / rel);
        } else {
          env = 1.0;
        }
        exc += (Math.random() * 2 - 1) * this._sustainAmp * env;
      }

      const p  = this._ptr;
      const pn = p < N ? p + 1 : 0;

      out[i] = this._buf[p];
      energy += out[i] * out[i];

      // Karplus-Strong one-zero LP + reflection sign + breath excitation
      this._buf[p] = c * (this._buf[p] * 0.5 + this._buf[pn] * 0.5) * d + exc;
      this._ptr = pn;
    }

    // Silence after sustain ends and resonator energy fades
    if (this._totalSamples >= ss && this._excPtr >= this._excBuf.length
        && energy / out.length < 1e-9) {
      this._active = false;
    }
    return true;
  }
}

registerProcessor('waveguide', WaveguideProcessor);
