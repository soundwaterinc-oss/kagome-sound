// EL-SYSTEMA ─ 通り道（transport）
//
// 案B 既定: ws://localhost:8787 の中継へ繋ぐ。
// 案差し替え可: BroadcastChannel 実装も小さく同居（同一オリジン内輪用）。
//
// 利用側からは createTransport({ kind, ... }) で同じ形のインタフェース:
//   transport.send(message)
//   transport.onMessage(cb)        // 受信ごとに cb(message)
//   transport.onOpen(cb)
//   transport.onClose(cb)
//   transport.close()
//
// 通り道は形式のみを担う。メッセージの意味は shared/el-systema-shapes.js。

(function (root) {
  "use strict";

  const DEFAULT_WS_URL = "ws://localhost:8787";
  const DEFAULT_BC_NAME = "el-systema-field";

  // ─ WebSocket transport (案B) ───────────────────────────────────────────────
  function createWsTransport(opts) {
    const url = (opts && opts.url) || DEFAULT_WS_URL;
    const reconnectMs = (opts && opts.reconnectMs) || 1200;
    let ws = null;
    let closed = false;
    const onMsg = [];
    const onOpen = [];
    const onClose = [];
    const outbox = [];

    function connect() {
      try {
        ws = new WebSocket(url);
      } catch (e) {
        if (!closed) setTimeout(connect, reconnectMs);
        return;
      }
      ws.addEventListener("open", function () {
        // 滞留分を吐く
        while (outbox.length) {
          try { ws.send(outbox.shift()); } catch (_) { break; }
        }
        for (let i = 0; i < onOpen.length; i++) onOpen[i]();
      });
      ws.addEventListener("message", function (ev) {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        for (let i = 0; i < onMsg.length; i++) onMsg[i](m);
      });
      ws.addEventListener("close", function () {
        for (let i = 0; i < onClose.length; i++) onClose[i]();
        if (!closed) setTimeout(connect, reconnectMs);
      });
      ws.addEventListener("error", function () { /* close が来る */ });
    }
    connect();

    return {
      kind: "ws",
      url,
      send: function (m) {
        const s = JSON.stringify(m);
        if (ws && ws.readyState === 1) {
          try { ws.send(s); } catch (_) { outbox.push(s); }
        } else {
          outbox.push(s);
        }
      },
      onMessage: function (cb) { onMsg.push(cb); },
      onOpen:    function (cb) { onOpen.push(cb); },
      onClose:   function (cb) { onClose.push(cb); },
      close: function () { closed = true; try { ws && ws.close(); } catch (_) {} },
    };
  }

  // ─ BroadcastChannel transport (同一オリジン内輪用・差し替え候補) ────────────
  function createBroadcastTransport(opts) {
    const name = (opts && opts.name) || DEFAULT_BC_NAME;
    if (typeof BroadcastChannel === "undefined") {
      return { kind: "broadcast", send: function(){}, onMessage: function(){}, onOpen: function(){}, onClose: function(){}, close: function(){} };
    }
    const bc = new BroadcastChannel(name);
    const onMsg = [];
    const onOpen = [];
    bc.onmessage = function (ev) {
      for (let i = 0; i < onMsg.length; i++) onMsg[i](ev.data);
    };
    // BroadcastChannel は open イベントが無いので microtask で疑似発火
    Promise.resolve().then(function () {
      for (let i = 0; i < onOpen.length; i++) onOpen[i]();
    });
    return {
      kind: "broadcast",
      name,
      send: function (m) { bc.postMessage(m); },
      onMessage: function (cb) { onMsg.push(cb); },
      onOpen:    function (cb) { onOpen.push(cb); },
      onClose:   function () { /* 同一オリジンチャンネルは閉じない */ },
      close: function () { try { bc.close(); } catch (_) {} },
    };
  }

  function createTransport(opts) {
    opts = opts || {};
    const kind = opts.kind || "ws";
    if (kind === "ws") return createWsTransport(opts);
    if (kind === "broadcast") return createBroadcastTransport(opts);
    throw new Error("unknown transport kind: " + kind);
  }

  root.ElSystemaTransport = {
    createTransport,
    createWsTransport,
    createBroadcastTransport,
    DEFAULT_WS_URL,
    DEFAULT_BC_NAME,
  };
})(typeof window !== "undefined" ? window : globalThis);
