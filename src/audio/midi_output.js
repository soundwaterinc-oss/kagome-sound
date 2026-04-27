/**
 * MIDI output module for EL-SYSTEMA.
 * Each scanner gets its own MIDI channel (1-based, ch 1-5).
 *
 * Note On/Off:  velocity = diagScore × 127
 * CC74 (filter cutoff): angle (0°/60°/120°) → 0/63/127
 * CC73 (attack time):   lenNorm → 0-127
 * CC7  (volume):        strokeNorm → 0-127
 *
 * Usage:
 *   import { MidiOutput } from './midi_output.js';
 *   const midi = new MidiOutput();
 *   await midi.init();          // requests MIDI access
 *   midi.noteOn(scannerIdx, hz, velocity, edge);
 *   midi.noteOff(scannerIdx, hz);
 */

export class MidiOutput {
  constructor() {
    this._access = null;
    this._output = null;
    this._noteMap = new Map(); // hz → midiNote (for noteOff tracking)
    this.enabled = false;
    this.onStatusChange = null; // callback(msg)
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this._status('Web MIDI API 非対応ブラウザです');
      return false;
    }
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: false });
      this._pickOutput();
      this._access.onstatechange = () => this._pickOutput();
      this.enabled = true;
      this._status(`MIDI準備完了: ${this._output?.name ?? 'none'}`);
      return true;
    } catch (err) {
      this._status(`MIDIアクセス失敗: ${err.message}`);
      return false;
    }
  }

  _pickOutput() {
    const outputs = [...this._access.outputs.values()];
    this._output = outputs[0] ?? null;
    this._status(this._output ? `出力: ${this._output.name}` : 'MIDI出力なし');
  }

  _status(msg) {
    if (this.onStatusChange) this.onStatusChange(msg);
  }

  /** hz → nearest MIDI note number (0-127) */
  _hzToMidi(hz) {
    return Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(hz / 440))));
  }

  /**
   * Send Note On.
   * @param {number} scannerIdx  0-based scanner index → MIDI channel 1-16
   * @param {number} hz          pitch in Hz
   * @param {number} vel01       velocity 0–1
   * @param {Object} edge        edge data { diagScore, angBin, lenNorm, strokeNorm }
   */
  noteOn(scannerIdx, hz, vel01, edge = {}) {
    if (!this.enabled || !this._output) return;
    const ch   = (scannerIdx % 16);              // 0-indexed → raw ch byte
    const note = this._hzToMidi(hz);
    const vel  = Math.max(1, Math.min(127, Math.round(vel01 * 127)));

    // Note On (status = 0x90 | ch)
    this._output.send([0x90 | ch, note, vel]);

    // CC74: filter → angle bin
    const cc74 = edge.angBin != null ? Math.round((edge.angBin / 120) * 127) : 64;
    this._output.send([0xB0 | ch, 74, cc74]);

    // CC73: attack → lenNorm
    if (edge.lenNorm != null) {
      this._output.send([0xB0 | ch, 73, Math.round(edge.lenNorm * 127)]);
    }

    // CC7: volume → strokeNorm
    if (edge.strokeNorm != null) {
      this._output.send([0xB0 | ch, 7, Math.round(edge.strokeNorm * 127)]);
    }

    // CC11: expression → diagScore
    if (edge.diagScore != null) {
      this._output.send([0xB0 | ch, 11, Math.round(edge.diagScore * 127)]);
    }

    // Remember for noteOff
    this._noteMap.set(`${ch}_${note}`, { ch, note });
  }

  /**
   * Send Note Off.
   */
  noteOff(scannerIdx, hz) {
    if (!this.enabled || !this._output) return;
    const ch   = scannerIdx % 16;
    const note = this._hzToMidi(hz);
    this._output.send([0x80 | ch, note, 0]);
    this._noteMap.delete(`${ch}_${note}`);
  }

  /** Silence all channels (panic). */
  allNotesOff() {
    if (!this.enabled || !this._output) return;
    for (let ch = 0; ch < 16; ch++) {
      this._output.send([0xB0 | ch, 123, 0]); // All Notes Off CC
    }
    this._noteMap.clear();
  }

  /** List available outputs. Returns array of { id, name }. */
  getOutputs() {
    if (!this._access) return [];
    return [...this._access.outputs.values()].map(o => ({ id: o.id, name: o.name }));
  }

  /** Select output by id. */
  selectOutput(id) {
    if (!this._access) return;
    this._output = this._access.outputs.get(id) ?? null;
    this._status(this._output ? `出力切替: ${this._output.name}` : 'MIDI出力なし');
  }
}
