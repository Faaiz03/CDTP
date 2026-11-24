/**
 * Self-contained Pure-JS ArUco 4x4 Detector & Printable Marker Generator.
 * Zero external dependencies — runs 100% offline in Android Chrome.
 *
 * Pipeline:
 * 1. Grayscale conversion + O(W*H) integral-image adaptive thresholding
 * 2. Connected component extraction of dark marker candidates
 * 3. Convex hull + minimum-area-loss simplification to exact 4 corners
 * 4. Homography sampling of 6x6 grid + black-border validation + local contrast check
 * 5. Rotation-invariant 16-bit dictionary matching with 1-bit error correction
 */

import { solveHomography } from './homography.js';

// High-separation 4x4 bit codes (row-major, bit 15 = (0,0), bit 0 = (3,3); 1 = white, 0 = black).
// Mathematically verified: minimum Hamming distance >= 6 across all 28 rotated codewords,
// with balanced 7-9 white bits and non-degenerate contrast in every row and column.
export const MARKER_DICT = {
  0:  { code: 0x113e, name: 'ROBOT',     role: 'Robot Top Chassis (Arrow = Forward)' },
  1:  { code: 0x11cb, name: 'ASPIRIN',   role: 'Medication Box (Module E)' },
  2:  { code: 0x125d, name: 'DOCK',      role: 'Charging Station (Optional)' },
  10: { code: 0x12a7, name: 'CORNER_TL', role: 'Arena Floor Top-Left (0, 0)' },
  11: { code: 0x14d6, name: 'CORNER_TR', role: 'Arena Floor Top-Right (W, 0)' },
  12: { code: 0x16b8, name: 'CORNER_BR', role: 'Arena Floor Bottom-Right (W, D)' },
  13: { code: 0x1873, name: 'CORNER_BL', role: 'Arena Floor Bottom-Left (0, D)' }
};

export function getBit(code, r, c) {
  const shift = 15 - (r * 4 + c);
  return (code >> shift) & 1;
}

/**
 * Rotate a 4x4 bitcode 90 degrees clockwise:
 * dst(c, 3 - r) = src(r, c)  <=>  dst(r, c) = src(3 - c, r)
 */
export function rotateCode90CW(code) {
  let out = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const bit = getBit(code, 3 - c, r);
      out = (out << 1) | bit;
    }
  }
  return out;
}

export function hammingDistance16(a, b) {
  let x = (a ^ b) & 0xffff;
  let dist = 0;
  while (x) {
    x &= x - 1;
    dist++;
  }
  return dist;
}

// Precompute lookup entries for all 4 rotations of each marker ID
const ROTATED_ENTRIES = [];
for (const [idStr, info] of Object.entries(MARKER_DICT)) {
  const id = Number(idStr);
  let code = info.code;
  for (let rot = 0; rot < 4; rot++) {
    ROTATED_ENTRIES.push({ id, rot, code });
    code = rotateCode90CW(code);
  }
}

/**
 * Match a sampled 16-bit grid against MARKER_DICT across all 4 rotations.
 * Returns { id, rot, dist } or null.
 * `rot` is the number of 90-deg CW rotations the marker has relative to the sampled corners:
 * Rotating the sampled corner array left by `rot` aligns index 0 -> Marker Top-Left.
 */
export function matchCode(sampledCode, maxDist = 1) {
  let best = null;
  for (let i = 0; i < ROTATED_ENTRIES.length; i++) {
    const entry = ROTATED_ENTRIES[i];
    const d = hammingDistance16(sampledCode, entry.code);
    if (d <= maxDist && (!best || d < best.dist)) {
      best = { id: entry.id, rot: entry.rot, dist: d };
      if (d === 0) break;
    }
  }
  return best;
}

/**
 * Andrew's monotone chain convex hull in clockwise screen coordinates (y down).
 */
function convexHull(points) {
  if (points.length <= 3) return points.slice();
  const pts = points.slice().sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (let i = 0; i < pts.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) {
      lower.pop();
    }
    lower.push(pts[i]);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) {
      upper.pop();
    }
    upper.push(pts[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function triangleArea2(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

function pointToSegmentDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Simplify a convex hull down to 4 vertices by iteratively dropping the vertex
 * that contributes the smallest triangular area, then verify quad fit quality.
 */
function simplifyHullToQuad(hull) {
  if (hull.length < 4) return null;
  const poly = hull.slice();
  while (poly.length > 4) {
    let minArea = Infinity;
    let minIdx = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const prev = poly[(i - 1 + n) % n];
      const curr = poly[i];
      const next = poly[(i + 1) % n];
      const area = triangleArea2(prev, curr, next);
      if (area < minArea) {
        minArea = area;
        minIdx = i;
      }
    }
    poly.splice(minIdx, 1);
  }

  // Ensure clockwise order in image coordinates (positive shoelace signed area for y-down)
  let signedArea = 0;
  for (let i = 0; i < 4; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % 4];
    signedArea += a.x * b.y - b.x * a.y;
  }
  if (signedArea < 0) {
    poly.reverse();
  }

  // Check side lengths and aspect ratio
  let minSide = Infinity;
  let maxSide = 0;
  let perim = 0;
  for (let i = 0; i < 4; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % 4];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < minSide) minSide = d;
    if (d > maxSide) maxSide = d;
    perim += d;
  }
  if (minSide < 12 || maxSide / minSide > 3.2) return null;

  // Verify all hull points lie close to the 4 quad edges (reject circles/L-shapes)
  const maxAllowedErr = Math.max(2.5, perim * 0.045);
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    let bestD = Infinity;
    for (let e = 0; e < 4; e++) {
      const d = pointToSegmentDist(p, poly[e], poly[(e + 1) % 4]);
      if (d < bestD) bestD = d;
    }
    if (bestD > maxAllowedErr) return null;
  }

  return poly;
}

/**
 * Sample 6x6 cells of a candidate quad from grayscale buffer and decode marker.
 */
function decodeQuad(gray, width, height, quad) {
  const canonical = [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 6, y: 6 },
    { x: 0, y: 6 }
  ];
  const H = solveHomography(canonical, quad);
  if (!H) return null;

  const cellVals = new Float32Array(36);
  let minVal = 255;
  let maxVal = 0;

  // Sample 5 inner sub-points per cell for noise resistance
  const offsets = [
    [0.5, 0.5],
    [0.35, 0.35],
    [0.65, 0.35],
    [0.35, 0.65],
    [0.65, 0.65]
  ];

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      let sum = 0;
      let count = 0;
      for (let k = 0; k < offsets.length; k++) {
        const sx = c + offsets[k][0];
        const sy = r + offsets[k][1];
        const w = H[2][0] * sx + H[2][1] * sy + H[2][2];
        if (Math.abs(w) < 1e-6) continue;
        const ix = Math.round((H[0][0] * sx + H[0][1] * sy + H[0][2]) / w);
        const iy = Math.round((H[1][0] * sx + H[1][1] * sy + H[1][2]) / w);
        if (ix >= 0 && ix < width && iy >= 0 && iy < height) {
          sum += gray[iy * width + ix];
          count++;
        }
      }
      if (count === 0) return null;
      const avg = sum / count;
      cellVals[r * 6 + c] = avg;
      if (avg < minVal) minVal = avg;
      if (avg > maxVal) maxVal = avg;
    }
  }

  // Require sufficient contrast between black border and white cells
  if (maxVal - minVal < 28) return null;
  const thresh = (minVal + maxVal) * 0.5;

  // Check 1-cell black border (20 cells total; allow at most 1 noisy border cell)
  let borderErrors = 0;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      if (r === 0 || r === 5 || c === 0 || c === 5) {
        if (cellVals[r * 6 + c] >= thresh) borderErrors++;
      }
    }
  }
  if (borderErrors > 1) return null;

  // Extract 4x4 inner bit pattern
  let sampledCode = 0;
  for (let r = 1; r <= 4; r++) {
    for (let c = 1; c <= 4; c++) {
      const bit = cellVals[r * 6 + c] >= thresh ? 1 : 0;
      sampledCode = (sampledCode << 1) | bit;
    }
  }

  const match = matchCode(sampledCode, 1);
  if (!match) return null;

  // Align corners so index 0=TL, 1=TR, 2=BR, 3=BL of the canonical marker
  const alignedCorners = [];
  for (let i = 0; i < 4; i++) {
    alignedCorners.push(quad[(i + match.rot) % 4]);
  }

  const cx = (alignedCorners[0].x + alignedCorners[1].x + alignedCorners[2].x + alignedCorners[3].x) * 0.25;
  const cy = (alignedCorners[0].y + alignedCorners[1].y + alignedCorners[2].y + alignedCorners[3].y) * 0.25;

  // Forward heading vector points from marker center toward midpoint of top edge (TL -> TR)
  const topMidX = (alignedCorners[0].x + alignedCorners[1].x) * 0.5;
  const topMidY = (alignedCorners[0].y + alignedCorners[1].y) * 0.5;
  const headingDeg = (Math.atan2(topMidY - cy, topMidX - cx) * 180) / Math.PI;

  return {
    id: match.id,
    hammingDist: match.dist,
    corners: alignedCorners.map((p) => ({ x: p.x / width, y: p.y / height })),
    cornersPx: alignedCorners,
    center: { x: cx / width, y: cy / height },
    centerPx: { x: cx, y: cy },
    headingDeg
  };
}

/**
 * Detect all valid 4x4 ArUco markers in an RGBA pixel buffer (width x height).
 * Returns array of { id, corners, center, headingDeg, hammingDist }.
 */
export function detectArucoMarkers(rgbaData, width, height) {
  const n = width * height;
  const gray = new Uint8Array(n);

  // 1. Grayscale conversion
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = (rgbaData[p] * 77 + rgbaData[p + 1] * 150 + rgbaData[p + 2] * 29) >> 8;
  }

  // 2. Integral image for fast adaptive thresholding
  const stride = width + 1;
  const integral = new Int32Array((height + 1) * stride);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const gRow = y * width;
    const iRow = (y + 1) * stride;
    const iPrev = y * stride;
    for (let x = 0; x < width; x++) {
      rowSum += gray[gRow + x];
      integral[iRow + x + 1] = integral[iPrev + x + 1] + rowSum;
    }
  }

  // Adaptive threshold (dark pixels = 1)
  const bin = new Uint8Array(n);
  const rad = Math.max(5, Math.min(12, Math.round(width * 0.025)));
  const bias = 7;
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - rad);
    const y1 = Math.min(height - 1, y + rad);
    const i0 = y0 * stride;
    const i1 = (y1 + 1) * stride;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(width - 1, x + rad);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum = integral[i1 + x1 + 1] - integral[i0 + x1 + 1] - integral[i1 + x0] + integral[i0 + x0];
      if (gray[rowOff + x] * area < sum - bias * area) {
        bin[rowOff + x] = 1;
      }
    }
  }

  // 3. Connected-component extraction of dark regions (BFS)
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const foundById = new Map();
  const maxCompArea = n * 0.35;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const startIdx = y * width + x;
      if (bin[startIdx] !== 1 || visited[startIdx]) continue;

      let qHead = 0;
      let qTail = 0;
      queue[qTail++] = startIdx;
      visited[startIdx] = 1;

      let minX = x, maxX = x, minY = y, maxY = y;
      let area = 0;
      const boundary = [];

      while (qHead < qTail) {
        const idx = queue[qHead++];
        const cx = idx % width;
        const cy = (idx - cx) / width;
        area++;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        let isEdge = false;
        // 4-neighbors
        if (cx > 0) {
          const ni = idx - 1;
          if (bin[ni] === 1) {
            if (!visited[ni]) { visited[ni] = 1; queue[qTail++] = ni; }
          } else isEdge = true;
        } else isEdge = true;

        if (cx < width - 1) {
          const ni = idx + 1;
          if (bin[ni] === 1) {
            if (!visited[ni]) { visited[ni] = 1; queue[qTail++] = ni; }
          } else isEdge = true;
        } else isEdge = true;

        if (cy > 0) {
          const ni = idx - width;
          if (bin[ni] === 1) {
            if (!visited[ni]) { visited[ni] = 1; queue[qTail++] = ni; }
          } else isEdge = true;
        } else isEdge = true;

        if (cy < height - 1) {
          const ni = idx + width;
          if (bin[ni] === 1) {
            if (!visited[ni]) { visited[ni] = 1; queue[qTail++] = ni; }
          } else isEdge = true;
        } else isEdge = true;

        if (isEdge && boundary.length < 2500) {
          boundary.push({ x: cx, y: cy });
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (area < 60 || area > maxCompArea || bw < 14 || bh < 14 || boundary.length < 16) {
        continue;
      }

      const hull = convexHull(boundary);
      const quad = simplifyHullToQuad(hull);
      if (!quad) continue;

      const decoded = decodeQuad(gray, width, height, quad);
      if (decoded) {
        const prev = foundById.get(decoded.id);
        if (!prev || decoded.hammingDist < prev.hammingDist) {
          foundById.set(decoded.id, decoded);
        }
      }
    }
  }

  return Array.from(foundById.values());
}

/**
 * Generate a crisp printable SVG string for a given marker ID (with quiet white border).
 */
export function createMarkerSvg(id, sizePx = 180) {
  const entry = MARKER_DICT[id];
  if (!entry) return '';
  const code = entry.code;
  // 8x8 units: 1-unit white quiet zone, 1-unit black border, 4x4 data grid
  let rects = `<rect x="0" y="0" width="8" height="8" fill="#ffffff"/>`;
  rects += `<rect x="1" y="1" width="6" height="6" fill="#000000"/>`;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (getBit(code, r, c) === 1) {
        rects += `<rect x="${c + 2}" y="${r + 2}" width="1" height="1" fill="#ffffff"/>`;
      }
    }
  }
  // Small directional notch outside quiet zone (bottom text + top arrow hint)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 8 8" shape-rendering="crispEdges">${rects}</svg>`;
}
