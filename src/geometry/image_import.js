/**
 * Image (PNG/JPG) → edge list importer.
 * Pipeline: threshold → contour pixels → Hough(0°/60°/120°) → segments
 *
 * Usage:
 *   import { parseImage } from './image_import.js';
 *   const edges = await parseImage(file, { width: 270, height: 270 });
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (source instanceof Blob || source instanceof File) {
      img.src = URL.createObjectURL(source);
    } else {
      img.src = source; // URL string
    }
  });
}

/** Pixel index helper */
const idx = (x, y, W) => y * W + x;

/**
 * Grayscale + threshold → binary array (1=black/structure, 0=white/hole)
 * Uses Otsu's method for adaptive threshold.
 */
function toBinary(rgba, W, H) {
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    gray[i] = Math.round(0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2]);
  }

  // Otsu threshold
  const hist = new Int32Array(256);
  for (const v of gray) hist[v]++;
  const N = W * H;
  let sumB = 0, wB = 0, total = 0;
  for (let i = 0; i < 256; i++) total += i * hist[i];
  let maxVar = 0, thresh = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (total - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > maxVar) { maxVar = v; thresh = t; }
  }

  const bin = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) bin[i] = gray[i] <= thresh ? 1 : 0;
  return bin;
}

/**
 * Find boundary pixels: black pixels that are adjacent to at least one white pixel.
 * Returns array of [x, y].
 */
function boundaryPixels(bin, W, H) {
  const pts = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!bin[idx(x, y, W)]) continue;
      if (!bin[idx(x-1,y,W)] || !bin[idx(x+1,y,W)] ||
          !bin[idx(x,y-1,W)] || !bin[idx(x,y+1,W)]) {
        pts.push([x, y]);
      }
    }
  }
  return pts;
}

/**
 * Simplified Hough transform restricted to 3 dominant angles (0°, 60°, 120°).
 * Returns detected line segments.
 */
function houghSegments(pts, W, H, minVotes = 12, peakGap = 6, minLen = 12) {
  if (!pts.length) return [];

  const DEGS = [0, 60, 120];
  const RADS = DEGS.map(d => d * Math.PI / 180);
  const diagLen = Math.ceil(Math.hypot(W, H));
  const rhoSize  = diagLen * 2 + 2;

  const segments = [];

  for (let ai = 0; ai < RADS.length; ai++) {
    const theta = RADS[ai];
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    // perpendicular direction (to travel along the line)
    const cosP = -sinT, sinP = cosT;

    // Accumulate votes: each edge pixel votes for its rho
    const acc = new Int32Array(rhoSize);
    const pixByRho = Array.from({ length: rhoSize }, () => []);
    for (const [x, y] of pts) {
      const rho = Math.round(x * cosT + y * sinT) + diagLen;
      if (rho < 0 || rho >= rhoSize) continue;
      acc[rho]++;
      pixByRho[rho].push([x, y]);
    }

    // Non-maximum suppression to find peaks
    const peaks = [];
    for (let r = peakGap; r < rhoSize - peakGap; r++) {
      if (acc[r] < minVotes) continue;
      let isMax = true;
      for (let dr = -peakGap; dr <= peakGap; dr++) {
        if (dr && acc[r + dr] >= acc[r]) { isMax = false; break; }
      }
      if (isMax) peaks.push(r);
    }

    // For each peak line, extract contiguous segments
    for (const rhoIdx of peaks) {
      const linePts = pixByRho[rhoIdx];
      if (!linePts.length) continue;

      // Project each point onto the line direction to get 1-D position
      const projected = linePts.map(([x, y]) => ({
        t: x * cosP + y * sinP,
        x, y,
      })).sort((a, b) => a.t - b.t);

      // Gap-split into contiguous runs
      const GAP = 8; // pixels gap tolerance
      let runStart = 0;
      for (let i = 1; i <= projected.length; i++) {
        const gapHere = i < projected.length ? projected[i].t - projected[i-1].t : GAP + 1;
        if (gapHere > GAP || i === projected.length) {
          const run = projected.slice(runStart, i);
          if (run.length >= 2) {
            const p1 = run[0], p2 = run[run.length - 1];
            const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            if (segLen >= minLen) {
              // strokeWeight = Hough vote count for this rho → proxy for line thickness
              segments.push({
                p1: [p1.x, p1.y],
                p2: [p2.x, p2.y],
                strokeWeight: acc[rhoIdx],
              });
            }
          }
          runStart = i;
        }
      }
    }
  }

  return segments;
}

/**
 * Fit all segments into (0,0)-(W,H) with uniform scale + centering.
 */
function fitToCanvas(segs, W, H, pad = 8, keepExtra = true) {
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
  return segs.map(s => ({ p1: map(s.p1), p2: map(s.p2), strokeWeight: s.strokeWeight ?? 0 }));
}

/**
 * Convert raw segments to engine edge schema with layer classification.
 */
function toEdges(segs, W, H) {
  const CX = W / 2, CY = H / 2;
  const dists = segs.map(s => Math.hypot((s.p1[0]+s.p2[0])/2 - CX, (s.p1[1]+s.p2[1])/2 - CY));
  const sorted = [...dists].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length * 0.33)];
  const t2 = sorted[Math.floor(sorted.length * 0.66)];

  // Normalize strokeWeight and len across all segments
  const weights = segs.map(s => s.strokeWeight ?? 0);
  const lens    = segs.map(s => Math.hypot(s.p2[0]-s.p1[0], s.p2[1]-s.p1[1]));
  const maxW = Math.max(...weights) || 1;
  const maxL = Math.max(...lens)    || 1;

  return segs.map(({ p1, p2, strokeWeight }, i) => {
    const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = lens[i];
    let ang = ((Math.atan2(dy, dx) * 180 / Math.PI) % 180 + 180) % 180;
    const angBin = ang < 30 || ang >= 150 ? 0 : ang < 90 ? 60 : 120;
    const diagScore = (mx / W + (H - my) / H) / 2;
    const xNorm = mx / W, yNorm = (H - my) / H;
    const cellDist = dists[i];
    const layer = cellDist <= t1 ? 'macro' : cellDist <= t2 ? 'mid' : 'micro';

    // strokeNorm: 0=thin/細い, 1=thick/太い → 低音・長decay
    const strokeNorm = (strokeWeight ?? 0) / maxW;
    // lenNorm: 0=short, 1=long
    const lenNorm = len / maxL;

    const r = Math.round(40 + diagScore * 180);
    const g = Math.round(60 - diagScore * 40);
    const b = Math.round(180 - diagScore * 150);

    return {
      p1: { x: p1[0], y: p1[1] },
      p2: { x: p2[0], y: p2[1] },
      mx, my, len, ang, angBin,
      diagScore, xNorm, yNorm, cellDist,
      layer,
      strokeNorm,   // ← 線の太さ (0–1)
      lenNorm,      // ← 線の長さ (0–1)
      baseColor: `rgba(${r},${g},${b},`,
    };
  });
}

/**
 * Main entry point.
 * source: File | Blob | URL string
 * Options: width, height (canvas target size), minVotes, minLen, workingSize
 */
export async function parseImage(source, {
  width = 270,
  height = 270,
  workingSize = 540,  // process at 2× then scale down (more edge pixels → better Hough)
  minVotes = 10,
  minLen = 14,
} = {}) {
  const img = await loadImageElement(source);

  // Draw to working canvas (potentially larger for detail)
  const wc = document.createElement('canvas');
  wc.width = workingSize; wc.height = workingSize;
  const wctx = wc.getContext('2d');
  wctx.drawImage(img, 0, 0, workingSize, workingSize);
  const idata = wctx.getImageData(0, 0, workingSize, workingSize).data;

  const bin = toBinary(idata, workingSize, workingSize);
  const bpts = boundaryPixels(bin, workingSize, workingSize);

  if (!bpts.length) throw new Error('エッジピクセルが検出されませんでした');

  const rawSegs = houghSegments(bpts, workingSize, workingSize, minVotes, 6, minLen);
  if (!rawSegs.length) throw new Error('ラインセグメントが検出されませんでした');

  const fitted = fitToCanvas(rawSegs, width, height);
  return toEdges(fitted, width, height);
}
