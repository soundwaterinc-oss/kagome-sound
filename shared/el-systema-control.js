// EL-SYSTEMA ─ 葉（leaf）／器に埋める双方向ラッパー
//
// 既存器の音源・UI を一切変えない。
// 観測は受動: 既存 master sum（GainNode）に「足すだけ」の AnalyserNode を一本繋ぐ。
//   既存に analyser を持つ器（geometry-scanner 等）は、それを共有しても良い
//   （observerAnalyser を渡せば足さない）。
// 御題受け: relay/<id>/all の play, stop, setParam, ramp, loadPreset, snapshot。
// 気配返し: kehai を 6Hz で流し、everSpoke 後の長期沈黙は silence で宣言。
//
// 利用側:
//   <script src="../shared/el-systema-shapes.js"></script>
//   <script src="../shared/el-systema-transport.js"></script>
//   <script src="../shared/el-systema-control.js"></script>
//   <script>
//     // 既存 init() の末尾で:
//     window.registerElSystemaInstrument({
//       id: "geometry-scanner",
//       audioContext: state.audioContext,
//       outputNode:   state.masterBus,
//       sharedAnalyser: state.analyser,   // 任意。あれば借りる
//       onPlay:     () => toggleTransport(),
//       onStop:     () => stopTransport(),
//       onSetParam: (n, v) => setParam(n, v),
//       onRamp:     (n, from, to, dur) => rampParam(n, from, to, dur),
//       onLoadPreset: (p) => loadPreset(p),
//       onSnapshot: () => getPreset(),
//     });
//   </script>

(function (root) {
  "use strict";

  const Shapes = root.ElSystemaShapes;
  const Transport = root.ElSystemaTransport;
  if (!Shapes || !Transport) {
    console.error("[el-systema] shapes/transport が未読込");
    return;
  }

  // 既定パラメータ
  const KEHAI_HZ = 6;
  const KEHAI_MS = Math.round(1000 / KEHAI_HZ);
  const TAU_SPEAK = 0.07;      // everSpoke 立ち上げ閾値
  const TAU_QUIET = 0.05;      // 静寂閾値
  const QUIET_SEC_DECLARE = 2; // この秒数 quiet が続けば silence 宣言

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // RMS と帯域からの kehai 推定
  function makeObserver(audioContext, outputNode, sharedAnalyser) {
    if (!audioContext || !outputNode) return null;

    let analyser = sharedAnalyser;
    let owned = false;
    if (!analyser) {
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      // 「足すだけ」── どこへも繋がない（destination 経路は変えない）
      try { outputNode.connect(analyser); } catch (e) { /* 既に繋がっている等 */ }
      owned = true;
    }

    const time = new Uint8Array(analyser.fftSize);
    const freq = new Uint8Array(analyser.frequencyBinCount);

    function read() {
      analyser.getByteTimeDomainData(time);
      analyser.getByteFrequencyData(freq);

      let sumSq = 0;
      for (let i = 0; i < time.length; i++) {
        const v = (time[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / time.length);
      // 対数圧縮 (rms ≒ 0..0.3 を 0..1 に膨らます)
      const presence = clamp01(Math.log10(1 + rms * 30) / Math.log10(1 + 30 * 0.3));

      // 低/高帯域の比（FFT bin の前半1/4 と後半1/4）
      const n = freq.length;
      let low = 0, high = 0;
      const lowEnd = Math.floor(n / 4);
      const highStart = Math.floor(n * 3 / 4);
      for (let i = 0; i < lowEnd; i++) low += freq[i] / 255;
      for (let i = highStart; i < n; i++) high += freq[i] / 255;
      low  = clamp01(low  / lowEnd);
      high = clamp01(high / (n - highStart));

      return { presence, low, high };
    }

    function dispose() {
      if (owned) { try { outputNode.disconnect(analyser); } catch (_) {} }
    }
    return { read, dispose };
  }

  function registerElSystemaInstrument(config) {
    if (!config || !config.id || typeof config.id !== "string") {
      throw new Error("[el-systema] id is required (string)");
    }

    const id = config.id;
    const transport = config.transport || Transport.createTransport({ kind: "ws", url: config.wsUrl });

    const observer = makeObserver(config.audioContext || null, config.outputNode || null, config.sharedAnalyser || null);

    // 葉のハンドラは on* と bare 両方受ける。器側はどちらで書いても良い。
    // 例: { play: run, stop: halt } も { onPlay: run, onStop: halt } も通る。
    const cb = {
      play:       config.onPlay       || config.play       || null,
      stop:       config.onStop       || config.stop       || null,
      setParam:   config.onSetParam   || config.setParam   || null,
      ramp:       config.onRamp       || config.ramp       || null,
      loadPreset: config.onLoadPreset || config.loadPreset || null,
      snapshot:   config.onSnapshot   || config.snapshot   || config.getPreset || null,
    };

    // ─ 気配（kehai）状態 ────────────────────────────────────────────
    let everSpoke = false;
    let lastSpokeAt = 0;
    let quietSince = 0;          // audioContext.currentTime（quiet 状態に入った時刻）
    let silenceDeclared = false;
    let kehaiTimer = null;

    function tick() {
      const ac = config.audioContext;
      const now = Shapes.nowMs();
      let presence = 0, low = 0, high = 0;
      if (observer) {
        const r = observer.read();
        presence = r.presence; low = r.low; high = r.high;
      }
      if (presence >= TAU_SPEAK) {
        everSpoke = true;
        lastSpokeAt = now;
        quietSince = 0;
        silenceDeclared = false;
      } else if (everSpoke && presence < TAU_QUIET) {
        if (!quietSince) quietSince = ac ? ac.currentTime : (now / 1000);
        const t = ac ? ac.currentTime : (now / 1000);
        const since = t - quietSince;
        if (!silenceDeclared && since >= QUIET_SEC_DECLARE) {
          transport.send({ t: "silence", from: id, since: since, at: now });
          silenceDeclared = true;
        }
      } else {
        quietSince = 0;
        silenceDeclared = false;
      }
      transport.send({
        t: "kehai", from: id,
        presence: +presence.toFixed(4),
        low:      +low.toFixed(4),
        high:     +high.toFixed(4),
        everSpoke: everSpoke,
        at: now,
      });
    }

    function startKehai() {
      if (kehaiTimer) return;
      kehaiTimer = setInterval(tick, KEHAI_MS);
    }
    function stopKehai() {
      if (!kehaiTimer) return;
      clearInterval(kehaiTimer);
      kehaiTimer = null;
    }

    // ─ 御題受け（relay）────────────────────────────────────────────
    const inflightRamps = {}; // name -> { rafId, token }
    function applyParam(name, value) {
      if (typeof cb.setParam !== "function") {
        sendErr("ramp", "setParam not provided");
        return false;
      }
      try {
        cb.setParam(name, value);
        return true;
      } catch (e) {
        sendErr("ramp", e.message || String(e));
        return false;
      }
    }
    function rampParam(name, from, to, durMs, startAt) {
      if (typeof cb.ramp === "function") {
        // 器が自前で実装するならそれを使う
        try { cb.ramp(name, from, to, durMs); } catch (e) { sendErr("ramp", e.message || String(e)); }
        return;
      }
      if (inflightRamps[name] && inflightRamps[name].rafId) {
        cancelAnimationFrame(inflightRamps[name].rafId);
      }
      if (!(durMs > 0)) {
        delete inflightRamps[name];
        applyParam(name, to);
        return;
      }
      const token = Shapes.newRelayId();
      const t0 = (typeof startAt === "number" && startAt > Shapes.nowMs()) ? startAt : Shapes.nowMs();
      inflightRamps[name] = { rafId: 0, token: token };
      function step() {
        const handle = inflightRamps[name];
        if (!handle || handle.token !== token) return;
        const now = Shapes.nowMs();
        if (now < t0) {
          handle.rafId = requestAnimationFrame(step);
          return;
        }
        const t = Math.min(1, (now - t0) / durMs);
        const v = from + (to - from) * t;
        if (!applyParam(name, v)) {
          delete inflightRamps[name];
          return;
        }
        if (t >= 1) {
          delete inflightRamps[name];
          return;
        }
        handle.rafId = requestAnimationFrame(step);
      }
      inflightRamps[name].rafId = requestAnimationFrame(step);
    }
    function cancelAllRamps() {
      for (const k in inflightRamps) {
        if (inflightRamps[k].rafId) cancelAnimationFrame(inflightRamps[k].rafId);
      }
      for (const k in inflightRamps) delete inflightRamps[k];
    }

    function sendAck(ofId) {
      transport.send({ t: "ack", from: id, of: ofId, ok: true, at: Shapes.nowMs() });
    }
    function sendErr(ofId, msg) {
      transport.send({ t: "err", from: id, of: ofId, msg: String(msg || "error"), at: Shapes.nowMs() });
    }

    function handleRelay(m) {
      if (m.target !== id && m.target !== "all") return;
      try {
        switch (m.cmd) {
          case "play":
            if (typeof cb.play === "function") cb.play();
            break;
          case "stop":
            cancelAllRamps();
            if (typeof cb.stop === "function") cb.stop();
            break;
          case "setParam":
            if (typeof cb.setParam === "function") cb.setParam(m.name, m.value);
            break;
          case "ramp":
            rampParam(m.name, m.from, m.to, m.dur, m.startAt);
            break;
          case "loadPreset":
            if (typeof cb.loadPreset === "function") cb.loadPreset(m.preset);
            break;
          case "snapshot":
            if (typeof cb.snapshot === "function") {
              const p = cb.snapshot();
              // snapshot は ack の戻りに乗せず、独立メッセージとして preset を返す
              transport.send({ t: "ack", from: id, of: m.id, ok: true, at: Shapes.nowMs(), preset: p });
              return;
            }
            break;
          default:
            sendErr(m.id, "unknown cmd: " + m.cmd);
            return;
        }
        sendAck(m.id);
      } catch (e) {
        sendErr(m.id, e.message || String(e));
      }
    }

    transport.onMessage(function (m) {
      if (!Shapes.isValid(m)) return;
      if (m.t === "relay") handleRelay(m);
      // kehai/silence/ack/err/maneki/kotodama は無視（巫が読む）
    });

    // 場へ参加した知らせ（最低限）
    transport.onOpen(function () {
      transport.send({ t: "kotodama", from: id, text: "(参じました)", at: Shapes.nowMs() });
    });

    startKehai();

    return {
      id,
      transport,
      getKehai: function () {
        const r = observer ? observer.read() : { presence: 0, low: 0, high: 0 };
        return {
          presence: r.presence, low: r.low, high: r.high,
          everSpoke: everSpoke, lastSpokeAt: lastSpokeAt,
        };
      },
      close: function () {
        stopKehai();
        cancelAllRamps();
        if (observer) observer.dispose();
        transport.close();
      },
    };
  }

  root.registerElSystemaInstrument = registerElSystemaInstrument;
})(typeof window !== "undefined" ? window : globalThis);
