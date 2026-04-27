/**
 * Cylindrical waveguide (pipe) synthesis worklet.
 * Open/closed switching via 'closed' parameter.
 * Messages: { type:'trigger', frequency, velocity, closed }
 */
class WaveguideProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'decay',     defaultValue: 0.998, minValue: 0.9, maxValue: 0.9999, automationRate: 'k-rate' },
      { name: 'velocity',  defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._forward = null;
    this._backward = null;
    this._ptr = 0;
    this._len = 0;
    this._active = false;
    this._closed = false; // open pipe vs closed pipe
    this.port.onmessage = (e) => {
      if (e.data.type === 'trigger') this._excite(e.data);
    };
  }

  _excite({ frequency, velocity, closed = false }) {
    // open pipe: delay = sampleRate/frequency/2 (round trip = fundamental)
    // closed pipe: delay = sampleRate/frequency/4 * 2 = sampleRate/(2*freq)?
    // simple: use same length, reflection sign differs
    const len = Math.max(2, Math.round(sampleRate / frequency / 2));
    this._forward  = new Float32Array(len);
    this._backward = new Float32Array(len);
    this._len = len;
    this._ptr = 0;
    this._closed = closed;
    this._active = true;

    // Excite at mouth end: short impulsive burst
    const burstLen = Math.min(len, 8);
    for (let i = 0; i < burstLen; i++) {
      const env = Math.sin(Math.PI * i / burstLen);
      this._forward[i] = (Math.random() * 2 - 1) * velocity * env;
    }
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this._active || !this._forward) { out.fill(0); return true; }

    const decay = parameters.decay[0];
    const len = this._len;

    for (let i = 0; i < out.length; i++) {
      const p = this._ptr;
      const next = (p + 1) % len;

      // output at center
      const sample = this._forward[p] + this._backward[p];
      out[i] = sample;

      // reflect at open end (pressure node → invert) or closed end (velocity node → same sign)
      const reflSign = this._closed ? 1 : -1;

      // travel: forward moves right, backward moves left
      const newFwd = this._forward[next] * decay;
      const newBwd = reflSign * this._forward[p] * decay;

      // combine reflections
      this._backward[p] = (this._backward[next] * decay + newBwd) * 0.5;
      this._forward[next] = newFwd;

      this._ptr = next;

      if (Math.abs(sample) < 1e-7) {
        this._active = false;
        while (i < out.length - 1) out[++i] = 0;
        break;
      }
    }
    return true;
  }
}

registerProcessor('waveguide', WaveguideProcessor);
