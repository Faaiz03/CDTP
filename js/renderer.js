/**
 * Interactive Arena & Live Camera Canvas Renderer.
 * Draws live video or simulator arena, perspective floor grid, 30 cm docking zone
 * with 90-degree approach sector, trajectory trail, ArUco quads + heading arrows,
 * HSV color locks, and burned-in telemetry watermark for MediaRecorder video capture.
 */

import { AppState, ARUCO_IDS } from './state.js';
import { applyHomography } from './homography.js';
import { runLiveVisionFrame } from './vision.js';

export function worldToCanvasPx(mx, my, w, h) {
  if (AppState.invHomographyMatrix) {
    const norm = applyHomography(AppState.invHomographyMatrix, mx, my, AppState.arena.widthM, AppState.arena.depthM);
    return { x: norm.x * w, y: norm.y * h };
  }
  return {
    x: (mx / AppState.arena.widthM) * w,
    y: (my / AppState.arena.depthM) * h
  };
}

export function startArenaRenderer(callbacks = {}) {
  const canvas = document.getElementById('arena-canvas');
  const video = document.getElementById('webcam-video');
  const procCanvas = document.getElementById('vision-proc-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    if (!canvas.parentElement) return;
    canvas.width = canvas.parentElement.clientWidth || 640;
    canvas.height = canvas.parentElement.clientHeight || 360;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  let frameCount = 0;
  let lastFpsTime = performance.now();
  let lastTrackTime = 0;

  function renderLoop(now) {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // FPS Counter
    frameCount++;
    if (now - lastFpsTime >= 1000) {
      const fpsBadge = document.getElementById('vision-fps-badge');
      if (fpsBadge) fpsBadge.textContent = `${frameCount} FPS`;
      frameCount = 0;
      lastFpsTime = now;
    }

    // 1. Background: Live Camera Video or Dark Arena Plane
    if (AppState.cameraActive && video && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, w, h);

      // Process vision frames at ~15 FPS for smooth Android mobile performance
      if (now - lastTrackTime >= 66) {
        runLiveVisionFrame(video, procCanvas, callbacks);
        lastTrackTime = now;
      }
    } else {
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, w, h);
    }

    // 2. Calibrated Perspective Floor Grid
    ctx.strokeStyle = AppState.cameraActive ? 'rgba(56, 189, 248, 0.30)' : '#1e293b';
    ctx.lineWidth = 1;
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const gx = (i / steps) * AppState.arena.widthM;
      const p1 = worldToCanvasPx(gx, 0, w, h);
      const p2 = worldToCanvasPx(gx, AppState.arena.depthM, w, h);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      const gy = (i / steps) * AppState.arena.depthM;
      const q1 = worldToCanvasPx(0, gy, w, h);
      const q2 = worldToCanvasPx(AppState.arena.widthM, gy, w, h);
      ctx.beginPath();
      ctx.moveTo(q1.x, q1.y);
      ctx.lineTo(q2.x, q2.y);
      ctx.stroke();
    }

    // Draw 4-point calibration polygon & corner handles
    if (AppState.calibPointsPx.length > 0) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      AppState.calibPointsPx.forEach((pt, idx) => {
        const cx = pt.x * w;
        const cy = pt.y * h;
        if (idx === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      if (AppState.calibPointsPx.length === 4) ctx.closePath();
      ctx.stroke();

      AppState.calibPointsPx.forEach((pt, idx) => {
        const cx = pt.x * w;
        const cy = pt.y * h;
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px JetBrains Mono';
        ctx.textAlign = 'left';
        ctx.fillText(`C${idx + 1}`, cx + 7, cy - 5);
      });
    }

    // 3. Docking Station Zone (30 cm radius + 90-degree IR approach sector)
    const dockPt = worldToCanvasPx(AppState.vision.dockPos.x, AppState.vision.dockPos.y, w, h);
    const dockEdge = worldToCanvasPx(
      AppState.vision.dockPos.x + AppState.arena.dockRadiusM,
      AppState.vision.dockPos.y,
      w,
      h
    );
    const dockRadiusPx = Math.max(22, Math.hypot(dockEdge.x - dockPt.x, dockEdge.y - dockPt.y));

    // Full 30 cm circle
    ctx.fillStyle = AppState.vision.inDockZone ? 'rgba(34, 211, 238, 0.24)' : 'rgba(6, 182, 212, 0.13)';
    ctx.strokeStyle = AppState.telemetry.hwChargingStat === 1 ? '#34d399' : 'rgba(6, 182, 212, 0.75)';
    ctx.lineWidth = AppState.vision.inDockZone ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.arc(dockPt.x, dockPt.y, dockRadiusPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 90-degree IR approach wedge
    const approachRad = (AppState.vision.dockApproachAngleDeg * Math.PI) / 180;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.beginPath();
    ctx.moveTo(dockPt.x, dockPt.y);
    ctx.arc(dockPt.x, dockPt.y, dockRadiusPx, approachRad - Math.PI / 4, approachRad + Math.PI / 4);
    ctx.closePath();
    ctx.fill();

    // Station block
    ctx.fillStyle = AppState.telemetry.hwChargingStat === 1 ? '#059669' : '#0891b2';
    ctx.fillRect(dockPt.x - 20, dockPt.y - 12, 40, 24);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(AppState.telemetry.hwChargingStat === 1 ? 'CHG ON' : 'DOCK', dockPt.x, dockPt.y + 3);

    // 4. Trajectory Trail
    if (AppState.vision.trajectory.length > 1) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      const p0 = worldToCanvasPx(AppState.vision.trajectory[0].x, AppState.vision.trajectory[0].y, w, h);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < AppState.vision.trajectory.length; i++) {
        const pi = worldToCanvasPx(AppState.vision.trajectory[i].x, AppState.vision.trajectory[i].y, w, h);
        ctx.lineTo(pi.x, pi.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 5. Tracked Markers (Live Camera) OR Simulated Robot
    if (AppState.cameraActive) {
      if (AppState.trackingMode === 'aruco') {
        drawArucoOverlays(ctx, w, h);
      } else {
        drawColorOverlays(ctx, w, h);
      }
    } else {
      drawSimulatedRobot(ctx, w, h);
    }

    // 6. Burned-In Audit Watermark (included in recorded .webm video)
    if (AppState.isTestRunning) {
      const sec = (AppState.testDurationMs / 1000).toFixed(1);
      const chgTxt = AppState.telemetry.hwChargingStat === 1 ? 'CHG:ON' : 'CHG:OFF';
      const boxTxt = AppState.vision.cargoSecure ? 'BOX:OK' : 'BOX:DROP';
      const barText = `YTU MOD-${AppState.currentTask} | T:${sec}s | D:${AppState.vision.distanceTraveledM.toFixed(2)}m | TILT:${AppState.telemetry.tiltDeg.toFixed(1)}° | ${chgTxt} | ${boxTxt}`;
      ctx.font = '11px JetBrains Mono';
      const textW = Math.min(w - 16, ctx.measureText(barText).width + 18);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
      ctx.fillRect(8, h - 28, textW, 22);
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'left';
      ctx.fillText(barText, 14, h - 13);
    }

    // 7. Update Live HUD DOM Overlays
    updateArenaHudDom();

    requestAnimationFrame(renderLoop);
  }

  requestAnimationFrame(renderLoop);
}

function drawArucoOverlays(ctx, w, h) {
  const markers = AppState.tracker.detectedMarkers || [];
  for (const m of markers) {
    const isRobot = m.id === ARUCO_IDS.ROBOT;
    const isBox = m.id === ARUCO_IDS.BOX;
    const isDock = m.id === ARUCO_IDS.DOCK;
    const color = isRobot ? '#22c55e' : isBox ? '#f43f5e' : isDock ? '#06b6d4' : '#f59e0b';

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    m.corners.forEach((pt, idx) => {
      const px = pt.x * w;
      const py = pt.y * h;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();

    // Draw heading arrow for Robot tag (center -> top-edge midpoint)
    const cx = m.center.x * w;
    const cy = m.center.y * h;
    if (isRobot) {
      const topMidX = ((m.corners[0].x + m.corners[1].x) * 0.5) * w;
      const topMidY = ((m.corners[0].y + m.corners[1].y) * 0.5) * h;
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (topMidX - cx) * 1.6, cy + (topMidY - cy) * 1.6);
      ctx.stroke();
    }

    const label = isRobot ? 'ROBOT #0' : isBox ? 'ASPIRIN #1' : isDock ? 'DOCK #2' : `CORNER #${m.id}`;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fillRect(cx - 38, cy - 32, 76, 16);
    ctx.fillStyle = color;
    ctx.font = 'bold 10px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy - 21);
  }
}

function drawColorOverlays(ctx, w, h) {
  if (AppState.tracker.robotDetected) {
    const rx = AppState.tracker.robotPx.x * w;
    const ry = AppState.tracker.robotPx.y * h;
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(rx - 24, ry - 24, 48, 48);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(rx - 36, ry - 42, 72, 16);
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 10px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('ROBOT LOCK', rx, ry - 31);
  }
  if (AppState.tracker.boxDetected) {
    const bx = AppState.tracker.boxPx.x * w;
    const by = AppState.tracker.boxPx.y * h;
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - 16, by - 16, 32, 32);
    ctx.fillStyle = '#fda4af';
    ctx.font = 'bold 9px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('ASPIRIN BOX', bx, by - 20);
  }
}

function drawSimulatedRobot(ctx, w, h) {
  const rPt = worldToCanvasPx(AppState.vision.robotPos.x, AppState.vision.robotPos.y, w, h);
  ctx.save();
  ctx.translate(rPt.x, rPt.y);
  ctx.rotate((AppState.vision.robotHeadingDeg * Math.PI) / 180);

  // Robot chassis
  ctx.fillStyle = '#2563eb';
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-22, -16, 44, 32, 6);
  else ctx.rect(-22, -16, 44, 32);
  ctx.fill();
  ctx.stroke();

  // Two coaxial wheels
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.fillRect(-14, -22, 28, 6);
  ctx.strokeRect(-14, -22, 28, 6);
  ctx.fillRect(-14, 16, 28, 6);
  ctx.strokeRect(-14, 16, 28, 6);

  // Mini ArUco icon on top
  ctx.fillStyle = '#000000';
  ctx.fillRect(-8, -8, 16, 16);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-5, -5, 5, 5);
  ctx.fillRect(0, 0, 5, 5);

  // Medication box on robot
  if (AppState.vision.cargoSecure) {
    ctx.fillStyle = '#ef4444';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.fillRect(-10, -5, 20, 10);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 7px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('ASPIRIN', 0, 2);
  }

  // Forward heading arrow
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(28, 0);
  ctx.stroke();
  ctx.restore();

  if (!AppState.vision.cargoSecure) {
    ctx.fillStyle = '#b91c1c';
    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = 1.5;
    ctx.fillRect(rPt.x + 28, rPt.y + 14, 22, 11);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('BOX DROPPED', rPt.x + 39, rPt.y + 36);
  }
}

function updateArenaHudDom() {
  const hudMotion = document.getElementById('hud-motion-state');
  const hudDir = document.getElementById('hud-direction-state');
  const liveDist = document.getElementById('live-distance-display');
  const dockBanner = document.getElementById('docking-hud-banner');
  const dockDistText = document.getElementById('docking-distance-text');

  if (hudMotion) {
    const ms = AppState.telemetry.motionState.replace(/_/g, ' ');
    hudMotion.textContent = ms;
    hudMotion.className =
      ms === 'REBALANCING'
        ? 'font-bold text-rose-400 uppercase tracking-wide'
        : ms === 'MOVING' || ms === 'TURNING'
          ? 'font-bold text-emerald-400 uppercase tracking-wide'
          : 'font-bold text-amber-400 uppercase tracking-wide';
  }
  if (hudDir) {
    hudDir.textContent = `${AppState.telemetry.directionLabel} (${AppState.vision.robotHeadingDeg.toFixed(0)}°)`;
  }
  if (liveDist) {
    liveDist.textContent = `${AppState.vision.distanceTraveledM.toFixed(2)} m`;
  }

  const distToDockCm = Math.round(
    Math.hypot(
      AppState.vision.robotPos.x - AppState.vision.dockPos.x,
      AppState.vision.robotPos.y - AppState.vision.dockPos.y
    ) * 100
  );

  if (dockBanner && dockDistText) {
    if (distToDockCm <= AppState.arena.dockRadiusM * 100) {
      dockBanner.classList.remove('opacity-0');
      const delay = AppState.runMetrics.chargeStartDelaySec;
      const suffix =
        AppState.telemetry.hwChargingStat === 1
          ? ` | CHG ON (${delay !== null ? delay.toFixed(1) + 's' : 'OK'})`
          : AppState.runMetrics.dockZoneEnteredAt
            ? ` | Timer: ${((Date.now() - AppState.runMetrics.dockZoneEnteredAt) / 1000).toFixed(1)}s / 5s`
            : '';
      dockDistText.textContent = `Dist: ${distToDockCm} cm${suffix}`;
    } else {
      dockBanner.classList.add('opacity-0');
    }
  }
}
