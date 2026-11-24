/**
 * Pure JavaScript 4-Point Projective Homography Engine.
 * Maps normalized image coordinates (u, v) in [0..1] <-> real-world floor meters (X, Y).
 */

export function gaussianElimination(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;

    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;

    for (let r = 0; r < n; r++) {
      if (r !== col) {
        const factor = M[r][col];
        for (let j = col; j <= n; j++) M[r][j] -= factor * M[col][j];
      }
    }
  }
  return M.map((row) => row[n]);
}

export function solveHomography(srcPts, dstPts) {
  if (!srcPts || !dstPts || srcPts.length !== 4 || dstPts.length !== 4) return null;
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const x = srcPts[i].x;
    const y = srcPts[i].y;
    const X = dstPts[i].x;
    const Y = dstPts[i].y;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = gaussianElimination(A, b);
  if (!h) return null;
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1.0]
  ];
}

export function applyHomography(H, x, y, fallbackW = 1.5, fallbackD = 1.5) {
  if (!H) {
    return { x: x * fallbackW, y: y * fallbackD };
  }
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  if (Math.abs(w) < 1e-9) return { x: 0, y: 0 };
  return {
    x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w,
    y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w
  };
}

export function computeFloorHomographies(calibPointsPx, widthM, depthM) {
  if (!calibPointsPx || calibPointsPx.length !== 4) {
    return { homographyMatrix: null, invHomographyMatrix: null };
  }
  const worldCorners = [
    { x: 0, y: 0 },
    { x: widthM, y: 0 },
    { x: widthM, y: depthM },
    { x: 0, y: depthM }
  ];
  const homographyMatrix = solveHomography(calibPointsPx, worldCorners);
  const invHomographyMatrix = solveHomography(worldCorners, calibPointsPx);
  return { homographyMatrix, invHomographyMatrix };
}
