/**
 * SVG → edge list importer.
 * Returns edges in the same schema as kagome.js buildKagome():
 *   { p1, p2, mx, my, len, ang, angBin, diagScore, xNorm, yNorm, cellDist, layer }
 *
 * Usage:
 *   import { parseSVG } from './svg_import.js';
 *   const edges = await parseSVG(file, { width: 270, height: 270 });
 */

/**
 * Sample a SVGPathElement at uniform intervals → array of [x,y] points
 */
function samplePath(pathEl, numSamples = 60) {
  const total = pathEl.getTotalLength();
  const pts = [];
  for (let i = 0; i <= numSamples; i++) {
    const pt = pathEl.getPointAtLength((i / numSamples) * total);
    pts.push([pt.x, pt.y]);
  }
  return pts;
}

/**
 * Extract raw point-pairs from all drawable SVG elements.
 * Returns Array of { p1:[x,y], p2:[x,y] }
 */
function extractRawSegments(svgDoc) {
  const segments = [];
  const ns = 'http://www.w3.org/2000/svg';

  // --- <line> ---
  for (const el of svgDoc.querySelectorAll('line')) {
    segments.push({
      p1: [+el.getAttribute('x1'), +el.getAttribute('y1')],
      p2: [+el.getAttribute('x2'), +el.getAttribute('y2')],
    });
  }

  // --- <polyline> / <polygon> ---
  for (const el of svgDoc.querySelectorAll('polyline,polygon')) {
    const raw = el.getAttribute('points').trim().split(/[\s,]+/).map(Number);
    const pts = [];
    for (let i = 0; i < raw.length - 1; i += 2) pts.push([raw[i], raw[i + 1]]);
    const closed = el.tagName.toLowerCase() === 'polygon';
    for (let i = 0; i < pts.length - 1; i++) segments.push({ p1: pts[i], p2: pts[i + 1] });
    if (closed && pts.length > 2) segments.push({ p1: pts[pts.length - 1], p2: pts[0] });
  }

  // --- <rect> ---
  for (const el of svgDoc.querySelectorAll('rect')) {
    const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0;
    const w = +el.getAttribute('width'), h = +el.getAttribute('height');
    const corners = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
    for (let i = 0; i < 4; i++) segments.push({ p1: corners[i], p2: corners[(i+1)%4] });
  }

  // --- <path> (sample uniformly then diff into segments) ---
  for (const el of svgDoc.querySelectorAll('path')) {
    if (!el.getTotalLength) continue; // only in browser DOM
    const pts = samplePath(el, 80);
    const MIN_SEG = 4; // skip tiny jitter steps
    let prev = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - prev[0], dy = pts[i][1] - prev[1];
      if (Math.hypot(dx, dy) >= MIN_SEG) {
        segments.push({ p1: [...prev], p2: [...pts[i]] });
        prev = pts[i];
      }
    }
  }

  return segments;
}

/**
 * De-duplicate near-identical segments (within tolerance px)
 */
function dedupe(segs, tol = 1.5) {
  const out = [];
  const seen = new Map();
  for (const s of segs) {
    const pts = [s.p1, s.p2].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const key = `${Math.round(pts[0][0]/tol)}_${Math.round(pts[0][1]/tol)}_${Math.round(pts[1][0]/tol)}_${Math.round(pts[1][1]/tol)}`;
    if (!seen.has(key)) { seen.set(key, true); out.push(s); }
  }
  return out;
}

/**
 * Fit all points into (0,0)-(W,H) with uniform scale + centering.
 */
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
  return segs.map(s => ({ p1: map(s.p1), p2: map(s.p2) }));
}

/**
 * 3-class layer assignment by simple k-means on segment midpoints.
 * Returns array of 'macro' | 'mid' | 'micro' for each segment.
 */
function assignLayers(segs) {
  const CX = segs.reduce((s, e) => s + (e.p1[0]+e.p2[0])/2, 0) / segs.length;
  const CY = segs.reduce((s, e) => s + (e.p1[1]+e.p2[1])/2, 0) / segs.length;

  const dists = segs.map(e => Math.hypot((e.p1[0]+e.p2[0])/2 - CX, (e.p1[1]+e.p2[1])/2 - CY));
  const sorted = [...dists].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length * 0.33)];
  const t2 = sorted[Math.floor(sorted.length * 0.66)];

  return dists.map(d => d <= t1 ? 'macro' : d <= t2 ? 'mid' : 'micro');
}

/**
 * Convert raw mapped segments to the engine edge schema.
 */
function toEdges(segs, W, H) {
  const layers = assignLayers(segs);
  const CX = W / 2, CY = H / 2;

  return segs.map(({ p1, p2 }, i) => {
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy);
    let ang = ((Math.atan2(dy, dx) * 180 / Math.PI) % 180 + 180) % 180;
    const angBin = ang < 30 || ang >= 150 ? 0 : ang < 90 ? 60 : 120;
    const diagScore = (mx / W + (H - my) / H) / 2;
    const xNorm = mx / W;
    const yNorm = (H - my) / H;
    const cellDist = Math.hypot(mx - CX, my - CY) / (W / 2);
    const layer = layers[i];

    // color tint from diagScore (same formula as kagome.js)
    const r = Math.round(40 + diagScore * 180);
    const g = Math.round(60 - diagScore * 40);
    const b = Math.round(180 - diagScore * 150);
    const baseColor = `rgba(${r},${g},${b},`;

    return {
      p1: { x: p1[0], y: p1[1] },
      p2: { x: p2[0], y: p2[1] },
      mx, my, len, ang, angBin,
      diagScore, xNorm, yNorm, cellDist,
      layer, baseColor,
    };
  });
}

/**
 * Main entry: parse an SVG File/Blob or SVG text string.
 * Returns Promise<Edge[]>
 */
export async function parseSVG(source, { width = 270, height = 270 } = {}) {
  let text;
  if (typeof source === 'string') {
    text = source;
  } else {
    text = await source.text();
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');

  const raw = extractRawSegments(doc);
  if (raw.length === 0) throw new Error('SVG内に認識できる線要素がありませんでした');

  // Filter zero-length segments
  const nonZero = raw.filter(s => {
    const dx = s.p2[0] - s.p1[0], dy = s.p2[1] - s.p1[1];
    return Math.hypot(dx, dy) > 0.5;
  });

  const deduped = dedupe(nonZero);
  const fitted  = fitToCanvas(deduped, width, height);
  return toEdges(fitted, width, height);
}
