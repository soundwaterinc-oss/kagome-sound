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

  // 背景タブでは setInterval が 1000ms 以上へ絞られ、kehai が途切れて卓が「切断」と誤認する。
  // Worker のタイマーはこの絞りを受けにくいので、可能な限り Worker で刻む（失敗時は setInterval）。
  function createTicker(ms, fn) {
    try {
      var src = "var t=null;onmessage=function(e){var d=e.data;if(d&&d.ms){clearInterval(t);t=setInterval(function(){postMessage(0);},d.ms);}else{clearInterval(t);t=null;}};";
      var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      var w = new Worker(url);
      w.onmessage = function () { fn(); };
      w.postMessage({ ms: ms });
      return { kind: "worker", stop: function () { try { w.postMessage(0); w.terminate(); URL.revokeObjectURL(url); } catch (e) {} } };
    } catch (e) {
      var h = setInterval(fn, ms);
      return { kind: "interval", stop: function () { clearInterval(h); } };
    }
  }

  // このページ読み込みを一意に表す印。卓はこれが変わった時だけ「新しく参加した」と判断して再同期する
  // （時間の隙間で判断すると、背景タブの絞りのたびに再同期が走って音量を押し戻してしまう）。
  var BOOT = Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);

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
    let stim = null;   // 刺激層（後段で自動アタッチ／attachAudio 時にも）
    const transport = config.transport || Transport.createTransport({ kind: "ws", url: config.wsUrl });

    // audio は登録時に無くてもよい（楽器が自分の開始ボタンで ctx を作る型）。後から attachAudio() で差し込む。
    let observer = makeObserver(config.audioContext || null, config.outputNode || null, config.sharedAnalyser || null);
    function attachAudio(a) {
      if (!a || !a.audioContext) return;
      config.audioContext = a.audioContext;
      if (a.outputNode) config.outputNode = a.outputNode;
      if (a.sharedAnalyser) config.sharedAnalyser = a.sharedAnalyser;
      if (observer) observer.dispose();
      observer = makeObserver(config.audioContext, config.outputNode || null, config.sharedAnalyser || null);
      if (!stim && typeof root.registerElSystemaStimulus === "function" && config.outputNode) {
        try { stim = root.registerElSystemaStimulus({ id: id, audioContext: config.audioContext, outputNode: config.outputNode, transport: transport }); } catch (e) {}
      }
    }

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
        ctx: ac ? ac.state : "none",      // 卓が「クリック待ち」を知るため（running / suspended / none）
        gesture: gestureArmed,            // 卓からの play を user gesture 待ちで保留中
        boot: BOOT,                       // ページ読み込みの識別子（卓の再同期判定に使う）
        hz: KEHAI_HZ,                     // 送信レート（卓が「切断」判定の猶予を決める）
        at: now,
      });
    }

    function startKehai() {
      if (kehaiTimer) return;
      kehaiTimer = createTicker(KEHAI_MS, tick);
    }
    function stopKehai() {
      if (!kehaiTimer) return;
      kehaiTimer.stop();
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

    // ─ 卓からの play と自動再生制限 ─────────────────────────────
    // ブラウザは user gesture の無いタブで AudioContext を起こせない（autoplay policy）。
    // 卓の ▶ が空振りする最大の原因なので、ここで面倒を見る:
    //   1) ctx が running なら即 play
    //   2) suspended なら resume() を試す（同一オリジンで既にクリック済みなら通る）
    //   3) 通らなければ画面に案内を出し、次の pointerdown/keydown で resume→play。卓には pending:"gesture" で返す
    let gestureArmed = false;
    let playedByGesture = false;
    let gestureOverlay = null;
    let gestureHandler = null;
    function doPlay() { if (typeof cb.play === "function") cb.play(); }
    function disarmGesture() {
      gestureArmed = false;
      if (gestureHandler) {
        window.removeEventListener("pointerdown", gestureHandler, true);
        window.removeEventListener("keydown", gestureHandler, true);
        gestureHandler = null;
      }
      if (gestureOverlay && gestureOverlay.parentNode) gestureOverlay.parentNode.removeChild(gestureOverlay);
      gestureOverlay = null;
    }
    // リスナーは先に張る（重い初期化中のクリックも取りこぼさない）。案内オーバーレイは判定後に出す。
    function armListener() {
      if (gestureHandler) return;
      gestureHandler = function () {
        const ac = config.audioContext;
        const p = ac && ac.state !== "running" ? ac.resume() : Promise.resolve();
        Promise.resolve(p).catch(function () {}).then(function () {
          disarmGesture();
          playedByGesture = true;   // 判定側が二重に play しないよう印を付ける
          doPlay();
          transport.send({ t: "kotodama", from: id, text: "(卓の ▶ を受けて鳴り始めました)", at: Shapes.nowMs() });
          tick();   // 卓へ即座に ctx:running を知らせる
        });
      };
      window.addEventListener("pointerdown", gestureHandler, true);
      window.addEventListener("keydown", gestureHandler, true);
    }
    function armGesture(ofId) {
      armListener();
      if (gestureArmed) return;
      gestureArmed = true;
      try {
        const d = document.createElement("div");
        d.setAttribute("data-els-gesture", "1");
        d.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;" +
          "background:rgba(4,8,10,.72);color:#d0ff5a;font:600 18px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.08em;" +
          "text-align:center;cursor:pointer;backdrop-filter:blur(2px)";
        d.innerHTML = '<div style="padding:28px 36px;border:1px solid #d0ff5a;border-radius:8px;background:#04080a">▶ 卓から play が届いています<br>' +
          '<span style="font-size:13px;color:#9fe8c0">この画面をクリック／キーを押すと鳴り始めます<br>（ブラウザの自動再生制限のため、最初の一度だけ必要）</span></div>';
        document.body.appendChild(d);
        gestureOverlay = d;
      } catch (e) { /* body 未生成等。listener だけで機能する */ }
    }
    function playRequested(m) {
      let ac = config.audioContext;
      if (!ac) {
        // 楽器がまだ ctx を持たない（開始ボタンで作る型）: まず play で起動させ、ctx が現れるのを待って状態を見る
        armListener();
        doPlay();
        const t0 = Shapes.nowMs();
        playedByGesture = false;
        (function poll() {
          ac = config.audioContext;
          if (playedByGesture || (ac && ac.state === "running")) { disarmGesture(); sendAck(m.id); return; }
          if (ac || Shapes.nowMs() - t0 > 2000) {
            if (!ac) { disarmGesture(); sendAck(m.id); return; }   // ctx を作らない楽器: 判定不能なので ack のみ
            armGesture(m.id);
            transport.send({ t: "ack", from: id, of: m.id, ok: true, pending: "gesture", at: Shapes.nowMs() });
            return;
          }
          setTimeout(poll, 100);
        })();
        return;
      }
      if (ac.state === "running") { doPlay(); sendAck(m.id); return; }
      armListener();
      let decided = false;
      playedByGesture = false;
      function decide(ok) {
        if (decided) return; decided = true; clearTimeout(timer);
        if (playedByGesture) { disarmGesture(); sendAck(m.id); return; }
        if (ok || ac.state === "running") { disarmGesture(); doPlay(); sendAck(m.id); return; }
        armGesture(m.id);
        transport.send({ t: "ack", from: id, of: m.id, ok: true, pending: "gesture", at: Shapes.nowMs() });
      }
      // resume() は autoplay でブロックされると reject せず pending のまま止まるので、時間で見切る
      const timer = setTimeout(function () { decide(false); }, 400);
      let p; try { p = ac.resume(); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function () { decide(ac.state === "running"); }, function () { decide(false); });
    }

    function handleRelay(m) {
      if (m.target !== id && m.target !== "all") return;
      try {
        switch (m.cmd) {
          case "play":
            playRequested(m);
            return;                       // ack は playRequested が返す（gesture 待ちなら pending 付き）
          case "stop":
            disarmGesture();
            cancelAllRamps();
            if (stim) stim.setParam("灯", 0);
            if (typeof cb.stop === "function") cb.stop();
            break;
          case "setParam":
            // 祭祀語彙の刺激パラメータは刺激層へ、その他は器へ
            if (stim && /^(灯|脈|息|眠|体|相|律|揺|光|刻|位)/.test(m.name)) { stim.setParam(m.name, m.value); break; }
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

    // ── 刺激層の自動アタッチ（全楽器共通・足すだけ）──
    // assr.js が読み込まれ、ctx/outputNode が渡されていれば、既存音源に触れず刺激層を並列に載せる。
    // これにより「灯/脈/息/眠/体/相/律/揺/光」の刺激パラメータが全楽器で自動的に使えるようになる。
    if (typeof root.registerElSystemaStimulus === "function" && config.audioContext && config.outputNode) {
      try {
        stim = root.registerElSystemaStimulus({
          id: id, audioContext: config.audioContext, outputNode: config.outputNode, transport: transport,
        });
      } catch (e) { /* 刺激層は任意。失敗しても器は通常動作 */ }
    }

    return {
      id,
      transport,
      attachAudio,
      get stimulus() { return stim; },
      getKehai: function () {
        const r = observer ? observer.read() : { presence: 0, low: 0, high: 0 };
        return {
          presence: r.presence, low: r.low, high: r.high,
          everSpoke: everSpoke, lastSpokeAt: lastSpokeAt,
        };
      },
      close: function () {
        disarmGesture();
        stopKehai();
        cancelAllRamps();
        if (observer) observer.dispose();
        transport.close();
      },
    };
  }

  root.registerElSystemaInstrument = registerElSystemaInstrument;
})(typeof window !== "undefined" ? window : globalThis);
