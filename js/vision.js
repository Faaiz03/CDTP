/**
 * Dual-Mode Live Computer Vision Engine:
 * - Mode 1: ArUco 4x4 Marker Tracking (exact heading, aspirin box tag, dock tag, auto 4-corner homography)
 * - Mode 2: Upgraded HSV Color Tracking (5x5 patch sampling + outlier-resistant centroid)
 *
 * Also computes:
 * - Live motion state: STATIC_BALANCE, MOVING, TURNING, REBALANCING
 * - Live direction: FORWARD, BACKWARD, LEFT, RIGHT, STATIONARY
 * - 30 cm Docking Zone entry/exit + strict <= 5.0 s hardware charging latency
 */

import { AppState, ARUCO_IDS, SPEC_LIMITS } from './state.js';
import { applyHomography, computeFloorHomographies } from './homography.js';
import { detectArucoMarkers } from './aruco.js';

export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, v };
}

export function hueDistance(h1, h2) {
  const diff = Math.abs(h1 - h2);
  return Math.min(diff, 360 - diff);
}

export function hsvToCss(hsv) {
  const h = Math.round(hsv.h);
  const s = Math.round(hsv.s * 100);
  const l = Math.round(hsv.v * 50);
  return `hsl(${h}, ${s}%, ${Math.max(35, Math.min(60, l))}%)`;
}

export function normalizeAngleDeg(deg) {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

export function shortestAngleDiffDeg(target, current) {
  return normalizeAngleDeg(target - current);
}

/**
 * Sample a 5x5 pixel patch around normalized (u, v) for stable HSV color picking.
 */
export function sampleVideoColorAt(video, procCanvas, u, v) {
  if (!procCanvas || !AppState.cameraActive || !video || video.readyState < 2) return null;
  const pctx = procCanvas.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);
  const cx = Math.min(procCanvas.width - 1, Math.max(0, Math.floor(u * procCanvas.width)));
  const cy = Math.min(procCanvas.height - 1, Math.max(0, Math.floor(v * procCanvas.height)));

  let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px >= 0 && px < procCanvas.width && py >= 0 && py < procCanvas.height) {
        const d = pctx.getImageData(px, py, 1, 1).data;
        rSum += d[0];
        gSum += d[1];
        bSum += d[2];
        cnt++;
      }
    }
  }
  if (cnt === 0) return null;
  return rgbToHsv(rSum / cnt, gSum / cnt, bSum / cnt);
}

/**
 * Update docking zone status & strict <= 5.0 s hardware charging verification timer.
 * Runs identically in both Live Camera and Simulator modes.
 */
export function updateDockingAndChargingTimers(now = Date.now()) {
  const distToDockM = Math.hypot(
    AppState.vision.robotPos.x - AppState.vision.dockPos.x,
    AppState.vision.robotPos.y - AppState.vision.dockPos.y
  );
  const inZone = distToDockM <= AppState.arena.dockRadiusM;
  AppState.vision.inDockZone = inZone;

  const chg = AppState.telemetry.hwChargingStat === 1;
  const rm = AppState.runMetrics;

  if (inZone) {
    if (!rm.dockZoneEnteredAt) {
      rm.dockZoneEnteredAt = now;
    }
    rm.dockExitAt = null;
  } else {
    if (rm.dockZoneEnteredAt && !rm.dockExitAt) {
      rm.dockExitAt = now;
    }
  }

  if (chg) {
    AppState.vision.isDocked = true;
    if (!rm.chargingStartedAt) {
      rm.chargingStartedAt = now;
      if (rm.dockZoneEnteredAt) {
        rm.chargeStartDelaySec = Math.max(0, (now - rm.dockZoneEnteredAt) / 1000.0);
      } else if (AppState.testStartTime) {
        // Robot already started inside dock zone or dock tag was not set
        rm.chargeStartDelaySec = Math.max(0, (now - AppState.testStartTime) / 1000.0);
      } else {
        rm.chargeStartDelaySec = 0;
      }
    }
    if (!rm.chargingStableSince) {
      rm.chargingStableSince = now;
    }
  } else {
    if (AppState.vision.isDocked && rm.dockExitAt && rm.chargeOffDelaySec === null) {
      rm.chargeOffDelaySec = Math.max(0, (now - rm.dockExitAt) / 1000.0);
    }
    AppState.vision.isDocked = false;
    rm.chargingStableSince = null;
  }

  return distToDockM;
}

/**
 * Classify live robot motion state and cardinal direction from vision + IMU telemetry.
 */
export function updateMotionAndDirection(stepDistM, dtSec, headingDeltaDeg, displacementAngleDeg) {
  const velMps = dtSec > 0.01 ? stepDistM / dtSec : 0;
  const angVelDps = dtSec > 0.01 ? headingDeltaDeg / dtSec : 0;
  AppState.vision.velocityMps = velMps;
  AppState.vision.angularVelDps = angVelDps;

  const absTilt = Math.abs(AppState.telemetry.tiltDeg);
  const absPitchRate = Math.abs(AppState.telemetry.pitchRateDps);

  let motionState = 'STATIC_BALANCE';
  let direction = 'STATIONARY';

  if (absTilt > 5.5 || absPitchRate > 18.0) {
    motionState = 'REBALANCING';
  } else if (Math.abs(angVelDps) > 22.0 && velMps < 0.08) {
    motionState = 'TURNING';
    direction = angVelDps > 0 ? 'RIGHT' : 'LEFT';
  } else if (velMps > 0.045) {
    motionState = Math.abs(angVelDps) > 25.0 ? 'TURNING' : 'MOVING';
    if (displacementAngleDeg !== null && AppState.vision.robotHeadingDeg !== null) {
      const rel = shortestAngleDiffDeg(displacementAngleDeg, AppState.vision.robotHeadingDeg);
      if (Math.abs(rel) <= 55) direction = 'FORWARD';
      else if (Math.abs(rel) >= 125) direction = 'BACKWARD';
      else direction = rel > 0 ? 'RIGHT' : 'LEFT';
    } else {
      direction = 'FORWARD';
    }
  } else {
    motionState = 'STATIC_BALANCE';
    direction = 'STATIONARY';
  }

  AppState.telemetry.motionState = motionState;
  AppState.telemetry.directionLabel = direction;

  if (AppState.isTestRunning) {
    AppState.runMetrics.motionStatesObserved.add(motionState);
    if (direction !== 'STATIONARY') {
      AppState.runMetrics.directionsObserved.add(direction);
      if (!AppState.runMetrics.firstMotionAt) {
        AppState.runMetrics.firstMotionAt = Date.now();
        AppState.runMetrics.initialBalanceHeldSec =
          (AppState.runMetrics.firstMotionAt - AppState.testStartTime) / 1000.0;
      }
    }
  }
}

/**
 * Apply a new detected robot position (normalized image coords + optional exact heading from ArUco).
 */
function applyRobotObservation(normX, normY, exactHeadingDeg, now, onCargoDrop) {
  AppState.tracker.robotDetected = true;
  AppState.tracker.robotPx = { x: normX, y: normY };

  const rawWorld = applyHomography(
    AppState.homographyMatrix,
    normX,
    normY,
    AppState.arena.widthM,
    AppState.arena.depthM
  );

  // Exponential low-pass filter to eliminate sub-cm jitter inflation
  if (!AppState.tracker.smoothedPos) {
    AppState.tracker.smoothedPos = { ...rawWorld };
  } else {
    const alpha = AppState.trackingMode === 'aruco' ? 0.45 : 0.32;
    AppState.tracker.smoothedPos.x += alpha * (rawWorld.x - AppState.tracker.smoothedPos.x);
    AppState.tracker.smoothedPos.y += alpha * (rawWorld.y - AppState.tracker.smoothedPos.y);
  }

  const dtSec = AppState.tracker.lastFrameTime > 0 ? (now - AppState.tracker.lastFrameTime) / 1000.0 : 0.08;
  AppState.tracker.lastFrameTime = now;

  const newX = AppState.tracker.smoothedPos.x;
  const newY = AppState.tracker.smoothedPos.y;
  const dx = newX - AppState.vision.robotPos.x;
  const dy = newY - AppState.vision.robotPos.y;
  const stepDist = Math.hypot(dx, dy);

  let displacementAngleDeg = null;
  let headingDelta = 0;

  if (exactHeadingDeg !== null && exactHeadingDeg !== undefined) {
    // Transform marker image-space heading into world-plane heading via homography
    if (AppState.tracker.smoothedHeadingDeg === null) {
      AppState.tracker.smoothedHeadingDeg = exactHeadingDeg;
    } else {
      const diff = shortestAngleDiffDeg(exactHeadingDeg, AppState.tracker.smoothedHeadingDeg);
      AppState.tracker.smoothedHeadingDeg = normalizeAngleDeg(AppState.tracker.smoothedHeadingDeg + 0.45 * diff);
    }
    headingDelta = shortestAngleDiffDeg(AppState.tracker.smoothedHeadingDeg, AppState.vision.robotHeadingDeg);
    AppState.vision.robotHeadingDeg = AppState.tracker.smoothedHeadingDeg;
  }

  // Reject impossible single-frame teleport jumps (> 0.40 m) and sub-1.5 cm sensor noise
  if (stepDist > 0.015 && stepDist < 0.40) {
    displacementAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (AppState.isTestRunning) {
      AppState.vision.distanceTraveledM += stepDist;
    }
    if (exactHeadingDeg === null || exactHeadingDeg === undefined) {
      headingDelta = shortestAngleDiffDeg(displacementAngleDeg, AppState.vision.robotHeadingDeg);
      AppState.vision.robotHeadingDeg = displacementAngleDeg;
    }
    AppState.vision.robotPos = { x: newX, y: newY };
    AppState.vision.trajectory.push({ x: newX, y: newY });
    if (AppState.vision.trajectory.length > 200) AppState.vision.trajectory.shift();
  }

  if (AppState.isTestRunning && Math.abs(headingDelta) > 2.0 && Math.abs(headingDelta) < 90) {
    AppState.runMetrics.headingDeltaAccumDeg += Math.abs(headingDelta);
  }

  updateMotionAndDirection(stepDist > 0.015 ? stepDist : 0, dtSec, headingDelta, displacementAngleDeg);
  updateDockingAndChargingTimers(now);
}

/**
 * Evaluate Medication Box (Aspirin) security check.
 */
function evaluateCargoMarker(detected, boxNormX, boxNormY, now, onCargoDrop) {
  if (detected) {
    AppState.tracker.boxDetected = true;
    AppState.tracker.boxMissingSince = null;
    AppState.tracker.boxPx = { x: boxNormX, y: boxNormY };

    if (AppState.tracker.robotDetected && AppState.isTestRunning && AppState.vision.cargoSecure) {
      const boxWorld = applyHomography(
        AppState.homographyMatrix,
        boxNormX,
        boxNormY,
        AppState.arena.widthM,
        AppState.arena.depthM
      );
      const sepM = Math.hypot(boxWorld.x - AppState.vision.robotPos.x, boxWorld.y - AppState.vision.robotPos.y);
      if (sepM > SPEC_LIMITS.BOX_SEP_FAIL_M) {
        onCargoDrop(`Medication box separated from robot (${(sepM * 100).toFixed(0)} cm)!`);
      }
    }
  } else {
    AppState.tracker.boxDetected = false;
    if (AppState.isTestRunning && AppState.tracker.robotDetected && AppState.vision.cargoSecure) {
      if (!AppState.tracker.boxMissingSince) {
        AppState.tracker.boxMissingSince = now;
      } else if (now - AppState.tracker.boxMissingSince > SPEC_LIMITS.BOX_MISSING_FAIL_MS) {
        onCargoDrop('Medication box lost from view (>2.5 s)!');
      }
    }
  }
}

/**
 * Run one frame of live computer vision (ArUco mode OR HSV Color mode).
 */
export function runLiveVisionFrame(video, procCanvas, callbacks = {}) {
  const { onCargoDrop = () => {}, onAutoCalibrated = () => {} } = callbacks;
  if (!procCanvas || !video || video.readyState < 2) return;

  const pctx = procCanvas.getContext('2d', { willReadFrequently: true });
  const pw = procCanvas.width;
  const ph = procCanvas.height;
  pctx.drawImage(video, 0, 0, pw, ph);
  const imgData = pctx.getImageData(0, 0, pw, ph).data;
  const now = Date.now();

  const statusEl = document.getElementById('tracker-lock-status');

  if (AppState.trackingMode === 'aruco') {
    const markers = detectArucoMarkers(imgData, pw, ph);
    AppState.tracker.detectedMarkers = markers;

    const robotTag = markers.find((m) => m.id === ARUCO_IDS.ROBOT);
    const boxTag = markers.find((m) => m.id === ARUCO_IDS.BOX);
    const dockTag = markers.find((m) => m.id === ARUCO_IDS.DOCK);

    // Optional Dock Marker ID 2 automatically locks dock position
    if (dockTag) {
      AppState.tracker.dockTagDetected = true;
      const dockWorld = applyHomography(
        AppState.homographyMatrix,
        dockTag.center.x,
        dockTag.center.y,
        AppState.arena.widthM,
        AppState.arena.depthM
      );
      AppState.vision.dockPos = dockWorld;
    } else {
      AppState.tracker.dockTagDetected = false;
    }

    // Optional Auto-Homography if all 4 floor corner tags (10, 11, 12, 13) are visible
    const cTL = markers.find((m) => m.id === ARUCO_IDS.CORNER_TL);
    const cTR = markers.find((m) => m.id === ARUCO_IDS.CORNER_TR);
    const cBR = markers.find((m) => m.id === ARUCO_IDS.CORNER_BR);
    const cBL = markers.find((m) => m.id === ARUCO_IDS.CORNER_BL);
    if (cTL && cTR && cBR && cBL && !AppState.isTestRunning) {
      const pts = [cTL.center, cTR.center, cBR.center, cBL.center];
      const { homographyMatrix, invHomographyMatrix } = computeFloorHomographies(
        pts,
        AppState.arena.widthM,
        AppState.arena.depthM
      );
      if (homographyMatrix) {
        const wasUncalibrated = !AppState.homographyMatrix;
        AppState.calibPointsPx = pts;
        AppState.homographyMatrix = homographyMatrix;
        AppState.invHomographyMatrix = invHomographyMatrix;
        if (wasUncalibrated) onAutoCalibrated();
      }
    }

    if (robotTag) {
      // Compute world-plane heading using homography of marker center -> marker top-edge midpoint
      const topMidNorm = {
        x: (robotTag.corners[0].x + robotTag.corners[1].x) * 0.5,
        y: (robotTag.corners[0].y + robotTag.corners[1].y) * 0.5
      };
      const wCenter = applyHomography(
        AppState.homographyMatrix,
        robotTag.center.x,
        robotTag.center.y,
        AppState.arena.widthM,
        AppState.arena.depthM
      );
      const wFront = applyHomography(
        AppState.homographyMatrix,
        topMidNorm.x,
        topMidNorm.y,
        AppState.arena.widthM,
        AppState.arena.depthM
      );
      const worldHeadingDeg = (Math.atan2(wFront.y - wCenter.y, wFront.x - wCenter.x) * 180) / Math.PI;

      applyRobotObservation(robotTag.center.x, robotTag.center.y, worldHeadingDeg, now, onCargoDrop);
      if (statusEl) {
        statusEl.textContent = `ArUco #0 LOCK (${AppState.vision.robotPos.x.toFixed(2)}m, ${AppState.vision.robotPos.y.toFixed(2)}m) | Tags: ${markers.length}`;
        statusEl.className = 'text-emerald-400';
      }
    } else {
      AppState.tracker.robotDetected = false;
      if (statusEl) {
        statusEl.textContent = `ArUco: Searching for ID #0 (seen: ${markers.map((m) => '#' + m.id).join(', ') || 'none'})`;
        statusEl.className = 'text-amber-400';
      }
    }

    evaluateCargoMarker(Boolean(boxTag), boxTag?.center.x || 0, boxTag?.center.y || 0, now, onCargoDrop);
    return;
  }

  // ---- MODE 2: HSV COLOR MARKER TRACKING ----
  AppState.tracker.detectedMarkers = [];
  const tol = AppState.tracker.hueTolerance;
  const minS = AppState.tracker.minSat;
  const minV = AppState.tracker.minVal;
  const rTarget = AppState.tracker.robotHSV;
  const bTarget = AppState.tracker.boxHSV;

  let rSumX = 0, rSumY = 0, rCount = 0;
  let bSumX = 0, bSumY = 0, bCount = 0;

  for (let y = 0; y < ph; y += 2) {
    for (let x = 0; x < pw; x += 2) {
      const idx = (y * pw + x) * 4;
      const hsv = rgbToHsv(imgData[idx], imgData[idx + 1], imgData[idx + 2]);
      if (hsv.s < minS || hsv.v < minV) continue;

      if (hueDistance(hsv.h, rTarget.h) <= tol) {
        rSumX += x;
        rSumY += y;
        rCount++;
      } else if (hueDistance(hsv.h, bTarget.h) <= tol) {
        bSumX += x;
        bSumY += y;
        bCount++;
      }
    }
  }

  const MIN_ROBOT_PX = 14;
  if (rCount >= MIN_ROBOT_PX) {
    const normX = rSumX / rCount / pw;
    const normY = rSumY / rCount / ph;
    applyRobotObservation(normX, normY, null, now, onCargoDrop);
    if (statusEl) {
      statusEl.textContent = `Color LOCK (${AppState.vision.robotPos.x.toFixed(2)}m, ${AppState.vision.robotPos.y.toFixed(2)}m)`;
      statusEl.className = 'text-emerald-400';
    }
  } else {
    AppState.tracker.robotDetected = false;
    if (statusEl) {
      statusEl.textContent = 'Color: Searching (tap Pick Robot Color)';
      statusEl.className = 'text-amber-400';
    }
  }

  evaluateCargoMarker(
    bCount >= 8,
    bCount >= 8 ? bSumX / bCount / pw : 0,
    bCount >= 8 ? bSumY / bCount / ph : 0,
    now,
    onCargoDrop
  );
}
