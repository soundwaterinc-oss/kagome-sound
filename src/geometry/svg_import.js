/**
 * SVG → edge list importer (v2).
 *
 * Improvements over v1:
 * - Live DOM injection so path.getTotalLength() / getPointAtLength() work
 * - viewBox-aware coordinate normalization
 * - Adaptive path sampling (~2px per sample, capped at 500 pts/path)
 * - strokeWidth → strokeNorm + lenNorm (matches image_import.js schema)
 * - circle/ellipse geometric sampling
 * - parseerror detection
 *
 * Usage:
 *   import { parseSVG } from './svg_import.js';
 *   const edges = await parseSVG(file, { width: 270, height: 270 });
 */

/** Sample a live SVGPathElement at adaptive intervals (~2px per sample). */
function samplePath(pathEl) {
  const total = pathEl.getTotalLength();
  if (!total) return [];
  const numSamples = Math.max(60, Math.min(500, Math.ceil(total / 2)));
  const pts = [];
  for (let i = 0; i <= numSamples; i++) {
    const pt = pathEl.getPointAtLength((i / numSamples) * total);
    pts.push([pt.x, pt.y]);
  }
  return pts;
}

/**
 * Extract raw point-pairs from all drawable SVG elements.
 * liveSvg must be a live DOM node (inserted into document) for path measurement.
 */
function extractRawSegments(liveSvg) {
  const segments = [];

  function sw(el) {
    return parseFloat(el.getAttribute('stroke-width') || el.style?.strokeWidth) || 1;
  }

  // <line>
  for (const el of liveSvg.querySelectorAll('line')) {
    segments.push({
      p1: [+el.getAttribute('x1') || 0, +el.getAttribute('y1') || 0],
      p2: [+el.getAttribute('x2') || 0, +el.getAttribute('y2') || 0],
      strokeWidth: sw(el),
    });
  }

  // <polyline> / <polygon>
  for (const el of liveSvg.querySelectorAll('polyline,polygon')) {
    const raw = el.getAttribute('points')?.trim().split(/[\s,]+/).map(Number) ?? [];
    const pts = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pts.push([raw[i], raw[i + 1]]);
    const closed = el.tagName.toLowerCase() === 'polygon';
    const s = sw(el);
    for (let i = 0; i < pts.length - 1; i++) segments.push({ p1: pts[i], p2: pts[i + 1], strokeWidth: s });
    if (closed && pts.length > 2) segments.push({ p1: pts[pts.length - 1], p2: pts[0], strokeWidth: s });
  }

  // <rect>
  for (const el of liveSvg.querySelectorAll('rect')) {
    const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0;
    const w = +el.getAttribute('width'), h = +el.getAttribute('height');
    if (!w || !h) continue;
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const s = sw(el);
    for (let i = 0; i < 4; i++) segments.push({ p1: corners[i], p2: corners[(i + 1) % 4], strokeWidth: s });
  }

  // <circle>
  for (const el of liveSvg.querySelectorAll('circle')) {
    const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0;
    const r = +el.getAttribute('r');
    if (!r) continue;
    const N = Math.max(16, Math.ceil(2 * Math.PI * r / 2));
    const s = sw(el);
    const circlePts = Array.from({ length: N + 1 }, (_, i) => {
      const a = (i / N) * 2 * Math.PI;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
    for (let i = 0; i < N; i++) segments.push({ p1: circlePts[i], p2: circlePts[i + 1], strokeWidth: s });
  }

  // <ellipse>
  for (const el of liveSvg.querySelectorAll('ellipse')) {
    const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0;
    const rx = +el.getAttribute('rx'), ry = +el.getAttribute('ry');
    if (!rx || !ry) continue;
    const N = Math.max(16, Math.ceil(Math.PI * (rx + ry) / 2));
    const s = sw(el);
    const pts = Array.from({ length: N + 1 }, (_, i) => {
      const a = (i / N) * 2 * Math.PI;
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    });
    for (let i = 0; i < N; i++) segments.push({ p1: pts[i], p2: pts[i + 1], strokeWidth: s });
  }

  // <path> — adaptive sampling at ~2px per point
  for (const el of liveSvg.querySelectorAll('path')) {
    if (typeof el.getTotalLength !== 'function') continue;
    const s = sw(el);
    const pts = samplePath(el);
    if (pts.length < 2) continue;
    const MIN_SEG = 2;
    let prev = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - prev[0], dy = pts[i][1] - prev[1];
      if (Math.hypot(dx, dy) >= MIN_SEG) {
        segments.push({ p1: [...prev], p2: [...pts[i]], strokeWidth: s });
        prev = pts[i];
      }
    }
  }

  return segments;
}

/** De-duplicate near-identical segments (within tolerance px). */
function dedupe(segs, tol = 1.5) {
  const seen = new Set();
  const out = [];
  for (const s of segs) {
    const pts = [[...s.p1], [...s.p2]].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const key = `${Math.round(pts[0][0]/tol)}_${Math.round(pts[0][1]/tol)}_${Math.round(pts[1][0]/tol)}_${Math.round(pts[1][1]/tol)}`;
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}

/** Fit all points into (0,0)-(W,H) with uniform scale + centering. */
function fitToCanvas(segs, W, H, pad = 8) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { p1, p2 } of segs) {
    for (const [x, y] of [p1, p2]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const sw = maxX - minX || 1, sh = maxY - minY || 1;
  const scale = Math.min((W - pad * 2) / sw, (H - pad * 2) / sh);
  const offX = (W - sw * scale) / 2 - minX * scale;
  const offY = (H - sh * scale) / 2 - minY * scale;
  const map = ([x, y]) => [x * scale + offX, y * scale + offY];
  return segs.map(s => ({ p1: map(s.p1), p2: map(s.p2), strokeWidth: s.strokeWidth }));
}

/** 3-class layer assignment by distance from centroid. */
function assignLayers(segs) {
  const CX = segs.reduce((s, e) => s + (e.p1[0] + e.p2[0]) / 2, 0) / segs.length;
  const CY = segs.reduce((s, e) => s + (e.p1[1] + e.p2[1]) / 2, 0) / segs.length;
  const dists = segs.map(e => Math.hypot((e.p1[0] + e.p2[0]) / 2 - CX, (e.p1[1] + e.p2[1]) / 2 - CY));
  const sorted = [...dists].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length * 0.33)];
  const t2 = sorted[Math.floor(sorted.length * 0.66)];
  return dists.map(d => d <= t1 ? 'macro' : d <= t2 ? 'mid' : 'micro');
}

/**
 * Convert mapped segments to engine edge schema.
 * Matches image_import.js output: includes lenNorm, strokeNorm, baseColor.
 */
function toEdges(segs, W, H) {
  const layers = assignLayers(segs);
  const CX = W / 2, CY = H / 2;
  const lens = segs.map(s => Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]));
  const strokes = segs.map(s => s.strokeWidth ?? 1);
  const maxL = Math.max(...lens) || 1;
  const maxSW = Math.max(...strokes) || 1;

  return segs.map(({ p1, p2, strokeWidth }, i) => {
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = lens[i];
    let ang = ((Math.atan2(dy, dx) * 180 / Math.PI) % 180 + 180) % 180;
    const angBin = ang < 30 || ang >= 150 ? 0 : ang < 90 ? 60 : 120;
    const diagScore = (mx / W + (H - my) / H) / 2;
    const xNorm = mx / W;
    const yNorm = (H - my) / H;
    const cellDist = Math.hypot(mx - CX, my - CY) / (W / 2);
    const layer = layers[i];
    const lenNorm = len / maxL;
    const strokeNorm = (strokeWidth ?? 1) / maxSW;

    const r = Math.round(40 + diagScore * 180);
    const g = Math.round(60 - diagScore * 40);
    const b = Math.round(180 - diagScore * 150);
    const baseColor = `rgba(${r},${g},${b},`;

    return {
      p1: { x: p1[0], y: p1[1] },
      p2: { x: p2[0], y: p2[1] },
      mx, my, len, ang, angBin,
      diagScore, xNorm, yNorm, cellDist,
      layer, lenNorm, strokeNorm, baseColor,
    };
  });
}

/**
 * Main entry: parse an SVG File/Blob or SVG text string.
 * Returns Promise<Edge[]>
 */
export async function parseSVG(source, { width = 270, height = 270 } = {}) {
  let text;
  if (typeof source === 'string') text = source;
  else text = await source.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('SVGパース失敗 / SVG parse error');
  }

  const srcSvg = doc.documentElement;

  // Determine coordinate space from viewBox (or width/height)
  const vb = srcSvg.getAttribute('viewBox');
  let vbW = 0, vbH = 0;
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length >= 4) { vbW = p[2]; vbH = p[3]; }
  }
  if (!vbW) vbW = parseFloat(srcSvg.getAttribute('width')) || 500;
  if (!vbH) vbH = parseFloat(srcSvg.getAttribute('height')) || 500;

  // Clone into live DOM so path.getTotalLength() / getPointAtLength() work
  const liveSvg = document.importNode(srcSvg, true);
  liveSvg.setAttribute('width', vbW);
  liveSvg.setAttribute('height', vbH);
  liveSvg.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;width:' + vbW +
    'px;height:' + vbH + 'px;visibility:hidden;pointer-events:none';
  document.body.appendChild(liveSvg);

  let raw;
  try {
    raw = extractRawSegments(liveSvg);
  } finally {
    document.body.removeChild(liveSvg);
  }

  if (raw.length === 0) throw new Error('SVG内に認識できる線要素がありませんでした');

  const nonZero = raw.filter(s => Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]) > 0.5);
  if (nonZero.length === 0) throw new Error('有効なセグメントが見つかりませんでした');

  const deduped = dedupe(nonZero);
  const fitted = fitToCanvas(deduped, width, height);
  return toEdges(fitted, width, height);
}
