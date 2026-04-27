/**
 * Karplus-Strong string synthesis worklet.
 * Parameters set via AudioWorkletNode.parameters (k-rate):
 *   frequency  : Hz (20–2000)
 *   decay      : 0–1 loop coefficient
 *   brightness : 0–1 amount of high-pass tilt on initial burst
 *   velocity   : 0–1 amplitude scale
 *   trigger    : any write causes re-excitation
 */
class KarplusStrongProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency',  defaultValue: 220,  minValue: 20,   maxValue: 2000, automationRate: 'k-rate' },
      { name: 'decay',      defaultValue: 0.996,minValue: 0.9,  maxValue: 0.9999,automationRate:'k-rate' },
      { name: 'brightness', defaultValue: 0.5,  minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
      { name: 'velocity',   defaultValue: 0.7,  minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._buf = null;
    this._ptr = 0;
    this._len = 0;
    this._active = false;
    this._prevSample = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'trigger') this._excite(e.data);
    };
  }

  _excite({ frequency, decay, brightness, velocity }) {
    const len = Math.max(2, Math.round(sampleRate / frequency));
    if (!this._buf || this._buf.length !== len) {
      this._buf = new Float32Array(len);
    }
    // Initial burst: band-colored noise based on brightness
    // brightness=0 → dark (filtered noise), brightness=1 → bright (white)
    const hp = brightness * 0.85;
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // simple one-pole HP: y = x - prev*hp
      const sample = white - prev * hp;
      this._buf[i] = sample * velocity;
      prev = sample;
    }
    this._len = len;
    this._ptr = 0;
    this._prevSample = 0;
    this._active = true;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;

    if (!this._active || !this._buf) {
      out.fill(0);
      return true;
    }

    const decay = parameters.decay[0];

    for (let i = 0; i < out.length; i++) {
      const cur = this._buf[this._ptr];
      // Karplus-Strong: average current + previous sample, apply decay
      const next = (cur + this._prevSample) * 0.5 * decay;
      this._buf[this._ptr] = next;
      out[i] = next;
      this._prevSample = cur;
      this._ptr = (this._ptr + 1) % this._len;

      // auto-silence below threshold
      if (Math.abs(next) < 1e-6) {
        this._active = false;
        while (i < out.length - 1) out[++i] = 0;
        break;
      }
    }
    return true;
  }
}

registerProcessor('karplus-strong', KarplusStrongProcessor);
