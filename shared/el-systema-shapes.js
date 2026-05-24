// EL-SYSTEMA ─ メッセージの形（schema と型ガード）
//
// すべてのメッセージは plain object。t（type）と at（実刻 ms）は必須。
// 古い JS でも読めるよう、ES module ではなく IIFE で window/globalThis に出す。
// hub（Node）からも require せずに同じ判定を共有できるよう module.exports も書く。

(function (root) {
  "use strict";

  const TYPES = ["relay", "kehai", "silence", "ack", "err", "maneki", "kotodama"];
  const CMDS  = ["play", "stop", "setParam", "ramp", "loadPreset", "snapshot"];
  const LITURGY_OPS = [">", "<", ">=", "<="];

  function isString(x) { return typeof x === "string" && x.length > 0; }
  function isNumber(x) { return typeof x === "number" && isFinite(x); }
  function isBool(x)   { return typeof x === "boolean"; }
  function isObj(x)    { return x && typeof x === "object" && !Array.isArray(x); }

  function nowMs() {
    return Date.now();
  }

  // 共通必須キー
  function hasCommon(m) {
    return isObj(m) && isString(m.t) && TYPES.indexOf(m.t) >= 0 && isNumber(m.at);
  }

  function isRelay(m) {
    if (!hasCommon(m) || m.t !== "relay") return false;
    if (!isString(m.target)) return false;
    if (!isString(m.cmd) || CMDS.indexOf(m.cmd) < 0) return false;
    if (!isString(m.id)) return false;
    switch (m.cmd) {
      case "play":
      case "stop":
      case "snapshot":
        return true;
      case "setParam":
        return isString(m.name) && (isNumber(m.value) || isString(m.value));
      case "ramp":
        return isString(m.name) && isNumber(m.from) && isNumber(m.to) && isNumber(m.dur) && isNumber(m.startAt);
      case "loadPreset":
        return isObj(m.preset);
      default:
        return false;
    }
  }

  function isKehai(m) {
    return hasCommon(m) && m.t === "kehai"
      && isString(m.from)
      && isNumber(m.presence) && isNumber(m.low) && isNumber(m.high)
      && isBool(m.everSpoke);
  }

  function isSilence(m) {
    return hasCommon(m) && m.t === "silence"
      && isString(m.from) && isNumber(m.since);
  }

  function isAck(m) {
    return hasCommon(m) && m.t === "ack"
      && isString(m.from) && isString(m.of) && isBool(m.ok);
  }

  function isErr(m) {
    return hasCommon(m) && m.t === "err"
      && isString(m.from) && isString(m.of) && isString(m.msg);
  }

  function isManeki(m) {
    return hasCommon(m) && m.t === "maneki"
      && isString(m.guise) && isNumber(m.startAt);
  }

  function isKotodama(m) {
    return hasCommon(m) && m.t === "kotodama"
      && isString(m.from) && isString(m.text);
  }

  function isValid(m) {
    if (!hasCommon(m)) return false;
    switch (m.t) {
      case "relay":    return isRelay(m);
      case "kehai":    return isKehai(m);
      case "silence":  return isSilence(m);
      case "ack":      return isAck(m);
      case "err":      return isErr(m);
      case "maneki":   return isManeki(m);
      case "kotodama": return isKotodama(m);
      default: return false;
    }
  }

  function explainLiturgy(o) {
    const errs = [];
    if (!isObj(o)) {
      errs.push("祭文 object ではない");
      return errs;
    }

    if (!isString(o.track)) errs.push("track が無い");
    if (!isNumber(o.duration) || o.duration <= 0) errs.push("duration が正数で無い");
    if (!Array.isArray(o["楽器"]) || o["楽器"].length === 0) {
      errs.push("楽器 が空でない array で無い");
    } else {
      o["楽器"].forEach(function (id, i) {
        if (!isString(id)) errs.push("楽器[" + i + "] が文字列で無い");
      });
    }
    if (!Array.isArray(o["祭次"])) errs.push("祭次 が array で無い");
    if (!Array.isArray(o["応答"])) errs.push("応答 が array で無い");
    if (errs.length) return errs;

    const ids = o["楽器"];
    const hasTarget = function (target) {
      return isString(target) && ids.indexOf(target) >= 0;
    };

    o["祭次"].forEach(function (seq, i) {
      if (!isObj(seq)) {
        errs.push("祭次[" + i + "] が object で無い");
        return;
      }
      if (!isNumber(seq["時"]) || seq["時"] < 0) errs.push("祭次[" + i + "].時 が 0 以上の数で無い");
      if (!isNumber(seq["揺"]) || seq["揺"] < 0) errs.push("祭次[" + i + "].揺 が 0 以上の数で無い");
      if (!hasTarget(seq["target"])) errs.push("祭次[" + i + "].target が 楽器 に無い");
      if (!isString(seq["command"]) || CMDS.indexOf(seq["command"]) < 0) {
        errs.push("祭次[" + i + "].command が不正");
        return;
      }
      switch (seq["command"]) {
        case "play":
        case "stop":
        case "snapshot":
          break;
        case "setParam":
          if (!isString(seq["param"])) errs.push("祭次[" + i + "].param が文字列で無い");
          if (seq["value"] === undefined) errs.push("祭次[" + i + "].value が無い");
          break;
        case "ramp":
          if (!isString(seq["param"])) errs.push("祭次[" + i + "].param が文字列で無い");
          if (!isNumber(seq["from"])) errs.push("祭次[" + i + "].from が数で無い");
          if (!isNumber(seq["to"])) errs.push("祭次[" + i + "].to が数で無い");
          if (!isNumber(seq["duration"]) || seq["duration"] < 0) errs.push("祭次[" + i + "].duration が 0 以上の数で無い");
          break;
        case "loadPreset":
          if (!isObj(seq["preset"])) errs.push("祭次[" + i + "].preset が object で無い");
          break;
      }
    });

    o["応答"].forEach(function (rule, i) {
      if (!isObj(rule)) {
        errs.push("応答[" + i + "] が object で無い");
        return;
      }
      if (!isString(rule["名"])) errs.push("応答[" + i + "].名 が文字列で無い");

      const cond = rule["時"];
      if (!isObj(cond)) {
        errs.push("応答[" + i + "].時 が object で無い");
      } else {
        if (!isString(cond["信号"])) errs.push("応答[" + i + "].時.信号 が文字列で無い");
        if (!isString(cond["演算"]) || LITURGY_OPS.indexOf(cond["演算"]) < 0) {
          errs.push("応答[" + i + "].時.演算 は > < >= <= のみ");
        }
        if (!isNumber(cond["値"])) errs.push("応答[" + i + "].時.値 が数で無い");
        if (cond["持続"] !== undefined && (!isNumber(cond["持続"]) || cond["持続"] < 0)) {
          errs.push("応答[" + i + "].時.持続 が 0 以上の数で無い");
        }
      }

      const act = rule["為"];
      if (!isObj(act)) {
        errs.push("応答[" + i + "].為 が object で無い");
      } else {
        if (!hasTarget(act["target"])) errs.push("応答[" + i + "].為.target が 楽器 に無い");
        if (!isString(act["command"]) || CMDS.indexOf(act["command"]) < 0) {
          errs.push("応答[" + i + "].為.command が不正");
        } else {
          switch (act["command"]) {
            case "play":
            case "stop":
            case "snapshot":
              break;
            case "setParam":
              if (!isString(act["param"])) errs.push("応答[" + i + "].為.param が文字列で無い");
              if (act["value"] === undefined) errs.push("応答[" + i + "].為.value が無い");
              break;
            case "ramp":
              if (!isString(act["param"])) errs.push("応答[" + i + "].為.param が文字列で無い");
              if (!isNumber(act["from"])) errs.push("応答[" + i + "].為.from が数で無い");
              if (!isNumber(act["to"])) errs.push("応答[" + i + "].為.to が数で無い");
              if (!isNumber(act["duration"]) || act["duration"] < 0) errs.push("応答[" + i + "].為.duration が 0 以上の数で無い");
              break;
            case "loadPreset":
              if (!isObj(act["preset"])) errs.push("応答[" + i + "].為.preset が object で無い");
              break;
          }
        }
      }

      if (rule["一度"] !== undefined && !isBool(rule["一度"])) errs.push("応答[" + i + "].一度 が boolean で無い");
      if (rule["冷却"] !== undefined && (!isNumber(rule["冷却"]) || rule["冷却"] < 0)) errs.push("応答[" + i + "].冷却 が 0 以上の数で無い");
    });

    return errs;
  }

  function isLiturgy(o) {
    return explainLiturgy(o).length === 0;
  }

  // 巫が新規 relay を作るときの id 採番（衝突しなければよい）
  let _seq = 0;
  function newRelayId() {
    _seq = (_seq + 1) | 0;
    return "r" + nowMs().toString(36) + "-" + _seq.toString(36);
  }

  const API = {
    TYPES, CMDS, LITURGY_OPS,
    nowMs, newRelayId,
    isRelay, isKehai, isSilence, isAck, isErr, isManeki, isKotodama, isValid,
    isLiturgy, explainLiturgy,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  } else {
    root.ElSystemaShapes = API;
  }
})(typeof window !== "undefined" ? window : globalThis);
