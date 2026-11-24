/**
 * Main Application Controller for YTU EEF Module D Robot Evaluator (PWA).
 */

import {
  AppState,
  TASK_DEFS,
  SPEC_LIMITS,
  loadSavedState,
  saveArenaState,
  resetRunMetrics
} from './state.js';
import { applyHomography, computeFloorHomographies } from './homography.js';
import { MARKER_DICT, createMarkerSvg } from './aruco.js';
import { hsvToCss, sampleVideoColorAt, updateDockingAndChargingTimers } from './vision.js';
import {
  setTiltChartInstance,
  startWatchdogTimer,
  startSimulatorLoop,
  connectWebBluetooth,
  connectWebSocket
} from './telemetry.js';
import {
  startVideoRecording,
  finalizeTestRun,
  exportJuryPdf,
  updateQrCode,
  computePayloadHash
} from './evaluator.js';
import { startArenaRenderer } from './renderer.js';

let tiltChart = null;
let selectedRecordId = null;

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  const colorClass =
    type === 'error'
      ? 'bg-rose-900/95 border-rose-500 text-rose-100'
      : type === 'success'
        ? 'bg-emerald-900/95 border-emerald-500 text-emerald-100'
        : type === 'warning'
          ? 'bg-amber-900/95 border-amber-500 text-amber-100'
          : 'bg-slate-900/95 border-brand-500 text-slate-100';
  toast.className = `p-3 rounded-xl border shadow-xl text-xs flex items-center gap-2 pointer-events-auto transition-all transform translate-y-2 opacity-0 duration-200 ${colorClass}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 250);
  }, 3600);
}

function setInteractiveMode(mode, text) {
  AppState.interactiveMode = mode;
  const banner = document.getElementById('interactive-mode-banner');
  const label = document.getElementById('interactive-mode-text');
  if (!banner || !label) return;
  if (mode === 'none') {
    banner.classList.add('hidden');
  } else {
    label.textContent = text;
    banner.classList.remove('hidden');
  }
}

function triggerCargoDropped(msg) {
  AppState.vision.cargoSecure = false;
  AppState.vision.cargoDropReason = msg;
  const cargoPill = document.getElementById('cargo-status-pill');
  const cargoText = document.getElementById('cargo-status-text');
  if (cargoPill && cargoText) {
    cargoPill.className =
      'bg-rose-950/90 backdrop-blur-md border border-rose-500 text-rose-300 px-3 py-1 rounded-lg flex items-center gap-1.5 text-xs font-semibold animate-bounce';
    cargoText.textContent = 'Aspirin Box: DROPPED (FAIL)';
  }
  showToast(msg, 'error');
}

function resetCargoBadge() {
  AppState.vision.cargoSecure = true;
  AppState.vision.cargoDropReason = '';
  const cargoPill = document.getElementById('cargo-status-pill');
  const cargoText = document.getElementById('cargo-status-text');
  if (cargoPill && cargoText) {
    cargoPill.className =
      'bg-emerald-950/80 backdrop-blur-md border border-emerald-500/40 text-emerald-300 px-3 py-1 rounded-lg flex items-center gap-1.5 text-xs font-semibold';
    cargoText.textContent = 'Aspirin Box: SECURE';
  }
}

function syncTrackingModeUI() {
  const btnAruco = document.getElementById('mode-btn-aruco');
  const btnColor = document.getElementById('mode-btn-color');
  const colorBtns = document.getElementById('color-picker-controls');
  const arucoInfo = document.getElementById('aruco-info-controls');

  const isAruco = AppState.trackingMode === 'aruco';
  if (btnAruco && btnColor) {
    btnAruco.className = isAruco
      ? 'px-2 py-0.5 rounded-md text-[11px] font-semibold bg-brand-600 text-white'
      : 'px-2 py-0.5 rounded-md text-[11px] font-medium text-slate-400 hover:text-white';
    btnColor.className = !isAruco
      ? 'px-2 py-0.5 rounded-md text-[11px] font-semibold bg-brand-600 text-white'
      : 'px-2 py-0.5 rounded-md text-[11px] font-medium text-slate-400 hover:text-white';
  }
  if (colorBtns) colorBtns.classList.toggle('hidden', isAruco);
  if (arucoInfo) arucoInfo.classList.toggle('hidden', !isAruco);

  const selectCalib = document.getElementById('calib-tracking-mode');
  if (selectCalib) selectCalib.value = AppState.trackingMode;
}

function initTiltChart() {
  const ctx = document.getElementById('tilt-history-chart');
  if (!ctx || typeof window.Chart === 'undefined') return;
  tiltChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels: Array.from({ length: 30 }, (_, i) => `-${30 - i}s`),
      datasets: [
        {
          label: 'Tilt Angle (°)',
          data: Array(30).fill(0),
          borderColor: '#0ea5e9',
          backgroundColor: 'rgba(14, 165, 233, 0.15)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        y: {
          min: -15,
          max: 15,
          grid: { color: 'rgba(51, 65, 85, 0.4)' },
          ticks: { color: '#94a3b8', font: { size: 9, family: 'JetBrains Mono' }, stepSize: 5 }
        },
        x: { grid: { display: false }, ticks: { display: false } }
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  });
  setTiltChartInstance(tiltChart);
}

function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      if (!targetTab) return;
      AppState.activeTab = targetTab;

      tabButtons.forEach((b) => {
        b.classList.remove('bg-brand-600', 'text-white');
        b.classList.add('text-slate-400');
      });
      btn.classList.add('bg-brand-600', 'text-white');
      btn.classList.remove('text-slate-400');

      document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
      const active = document.getElementById(targetTab);
      if (active) active.classList.remove('hidden');

      if (targetTab === 'tab-dashboard' && tiltChart) tiltChart.resize();
    });
  });
}

function setupTaskSelection() {
  const taskCards = document.querySelectorAll('.task-card');
  taskCards.forEach((card) => {
    card.addEventListener('click', () => {
      const taskId = card.getAttribute('data-select-task');
      if (!taskId || AppState.isTestRunning) return;
      AppState.currentTask = taskId;

      taskCards.forEach((c) => {
        c.classList.remove('border-brand-500', 'bg-brand-600/20', 'text-white');
        c.classList.add('border-slate-800', 'bg-slate-950', 'text-slate-300');
      });
      card.classList.add('border-brand-500', 'bg-brand-600/20', 'text-white');
      card.classList.remove('border-slate-800', 'bg-slate-950', 'text-slate-300');

      const def = TASK_DEFS[taskId];
      if (def) {
        const titleEl = document.getElementById('current-task-title');
        if (titleEl) titleEl.textContent = def.metric;
        showToast(`Selected: ${def.badge}`, 'info');
      }
    });
  });
}

function renderRubricScorecard() {
  let totalSubtest = 0;
  for (const key of ['A', 'B', 'C', 'E']) {
    const cell = document.getElementById(`rubric-stat-${key.toLowerCase()}`);
    const res = AppState.rubricResults[key];
    if (!cell) continue;
    if (!res) {
      cell.textContent = 'READY';
      cell.className = 'font-mono text-right text-slate-400 font-bold';
    } else if (res.pass) {
      cell.textContent = 'PASS (5/5)';
      cell.className = 'font-mono text-right text-emerald-400 font-bold';
      totalSubtest += 5;
    } else {
      cell.textContent = 'FAIL (0/5)';
      cell.className = 'font-mono text-right text-rose-400 font-bold';
    }
  }
  const totalBadge = document.getElementById('rubric-total-score');
  if (totalBadge) {
    totalBadge.textContent = `Evaluated Score: ${totalSubtest}/20 Subtest`;
  }
}

function renderHistoryList() {
  const listContainer = document.getElementById('test-history-list');
  const countEl = document.getElementById('history-count');
  if (!listContainer) return;

  countEl.textContent = `${AppState.testHistory.length} Records`;

  if (AppState.testHistory.length === 0) {
    listContainer.innerHTML = `<div class="p-4 rounded-xl bg-slate-950 border border-slate-800 text-center text-slate-500 text-xs">No tests executed yet. Start a test in the Evaluation Arena to record an official sealed run and video.</div>`;
    return;
  }

  if (!selectedRecordId && AppState.testHistory[0]) {
    selectedRecordId = AppState.testHistory[0].id;
    const hashEl = document.getElementById('sha256-hash-display');
    if (hashEl) hashEl.textContent = AppState.testHistory[0].hash;
    updateQrCode(AppState.testHistory[0].hash);
  }

  listContainer.innerHTML = AppState.testHistory
    .map((rec) => {
      const checksHtml = (rec.checks || [])
        .map(
          (c) =>
            `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono ${
              c.ok ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30' : 'bg-rose-950/80 text-rose-300 border border-rose-500/30'
            }">${c.ok ? '✓' : '✗'} ${c.label}</span>`
        )
        .join('');

      return `
      <div class="p-3.5 rounded-xl bg-slate-950 border ${
        rec.pass ? 'border-emerald-500/40' : 'border-rose-500/40'
      } flex flex-col gap-2.5 text-xs">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <span class="font-bold text-white font-mono">${rec.id}</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300">Mod ${rec.task}</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${
                rec.pass ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
              }">${rec.pass ? 'PASS (5/5)' : 'FAIL (0/5)'}</span>
              <span class="text-slate-500 text-[10px]">${rec.date}</span>
            </div>
            <p class="text-slate-400 text-[11px]">${rec.reason}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            ${
              rec.videoUrl
                ? `<a href="${rec.videoUrl}" download="YTU_${rec.id}_Mod${rec.task}.webm" class="px-2.5 py-1.5 rounded-lg bg-brand-600/20 hover:bg-brand-600/40 border border-brand-500/40 text-brand-300 font-semibold text-[11px]">Video (.webm)</a>`
                : ''
            }
            <button data-pdf-id="${rec.id}" class="btn-row-pdf px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-[11px]">PDF</button>
            <button data-verify-id="${rec.id}" class="btn-row-verify px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold text-[11px]">Verify Seal</button>
          </div>
        </div>
        ${checksHtml ? `<div class="flex flex-wrap gap-1.5">${checksHtml}</div>` : ''}
        <div class="flex items-center justify-between font-mono text-[10px] text-slate-500 border-t border-slate-800/70 pt-1.5">
          <span class="truncate max-w-[70%]">SHA-256: ${rec.hash}</span>
          <span>${rec.distance} m · ${rec.duration} s</span>
        </div>
      </div>`;
    })
    .join('');

  listContainer.querySelectorAll('.btn-row-pdf').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rec = AppState.testHistory.find((r) => r.id === btn.dataset.pdfId);
      if (rec) exportJuryPdf(rec, showToast);
    });
  });

  listContainer.querySelectorAll('.btn-row-verify').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rec = AppState.testHistory.find((r) => r.id === btn.dataset.verifyId);
      if (!rec) return;
      selectedRecordId = rec.id;
      const hashEl = document.getElementById('sha256-hash-display');
      if (hashEl) hashEl.textContent = rec.hash;
      updateQrCode(rec.hash);
      if (!rec.payload) {
        showToast('Legacy record format (no raw payload attached).', 'warning');
        return;
      }
      const recomputed = await computePayloadHash(rec.payload);
      if (recomputed === rec.hash) {
        showToast(`SEAL VERIFIED (${rec.id}): SHA-256 matches unaltered payload.`, 'success');
      } else {
        showToast(`TAMPER ALERT (${rec.id}): Payload hash mismatch!`, 'error');
      }
    });
  });
}

function setupCanvasInteractions() {
  const canvas = document.getElementById('arena-canvas');
  const video = document.getElementById('webcam-video');
  const procCanvas = document.getElementById('vision-proc-canvas');
  if (!canvas) return;

  function getNormalizedPointer(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX !== undefined ? e.clientX : e.touches?.[0]?.clientX ?? 0;
    const clientY = e.clientY !== undefined ? e.clientY : e.touches?.[0]?.clientY ?? 0;
    return {
      u: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      v: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
  }

  let isDragging = false;

  function updateSimRobotPos(u, v) {
    const mx = u * AppState.arena.widthM;
    const my = v * AppState.arena.depthM;
    const dx = mx - AppState.vision.robotPos.x;
    const dy = my - AppState.vision.robotPos.y;
    const delta = Math.hypot(dx, dy);
    if (delta > 0.005) {
      if (AppState.isTestRunning) AppState.vision.distanceTraveledM += delta;
      AppState.vision.robotHeadingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      AppState.telemetry.motionState = 'MOVING';
      AppState.telemetry.directionLabel = 'FORWARD';
      AppState.runMetrics.directionsObserved.add('FORWARD');
    }
    AppState.vision.robotPos.x = Math.max(0.05, Math.min(AppState.arena.widthM - 0.05, mx));
    AppState.vision.robotPos.y = Math.max(0.05, Math.min(AppState.arena.depthM - 0.05, my));
    AppState.vision.trajectory.push({ x: AppState.vision.robotPos.x, y: AppState.vision.robotPos.y });
    if (AppState.vision.trajectory.length > 160) AppState.vision.trajectory.shift();
    updateDockingAndChargingTimers(Date.now());
  }

  function handleCanvasTap(e) {
    const { u, v } = getNormalizedPointer(e);

    if (AppState.interactiveMode === 'calib_floor') {
      AppState.calibPointsPx.push({ x: u, y: v });
      const labels = ['Top-Left', 'Top-Right', 'Bottom-Right', 'Bottom-Left'];
      if (AppState.calibPointsPx.length < 4) {
        setInteractiveMode(
          'calib_floor',
          `Tap corner ${AppState.calibPointsPx.length + 1} of 4 (${labels[AppState.calibPointsPx.length]}) on the floor...`
        );
      } else {
        const res = computeFloorHomographies(AppState.calibPointsPx, AppState.arena.widthM, AppState.arena.depthM);
        AppState.homographyMatrix = res.homographyMatrix;
        AppState.invHomographyMatrix = res.invHomographyMatrix;
        saveArenaState();
        setInteractiveMode('none', '');
        showToast('4-Corner Floor Homography calibrated & saved!', 'success');
      }
      return;
    }

    if (AppState.interactiveMode === 'pick_robot') {
      const hsv = sampleVideoColorAt(video, procCanvas, u, v);
      if (hsv) {
        AppState.tracker.robotHSV = hsv;
        document.getElementById('swatch-robot-color').style.backgroundColor = hsvToCss(hsv);
        showToast(`Robot tracker color locked (Hue ${Math.round(hsv.h)}°)`, 'success');
      } else {
        showToast('Start the live camera first to pick a color', 'warning');
      }
      setInteractiveMode('none', '');
      return;
    }

    if (AppState.interactiveMode === 'pick_box') {
      const hsv = sampleVideoColorAt(video, procCanvas, u, v);
      if (hsv) {
        AppState.tracker.boxHSV = hsv;
        document.getElementById('swatch-box-color').style.backgroundColor = hsvToCss(hsv);
        showToast(`Medication box color locked (Hue ${Math.round(hsv.h)}°)`, 'success');
      } else {
        showToast('Start the live camera first to pick a color', 'warning');
      }
      setInteractiveMode('none', '');
      return;
    }

    if (AppState.interactiveMode === 'place_dock') {
      const worldPt = applyHomography(AppState.homographyMatrix, u, v, AppState.arena.widthM, AppState.arena.depthM);
      AppState.vision.dockPos = { x: worldPt.x, y: worldPt.y };
      saveArenaState();
      setInteractiveMode('none', '');
      showToast(`Dock station set to (${worldPt.x.toFixed(2)} m, ${worldPt.y.toFixed(2)} m)`, 'success');
      return;
    }

    if (!AppState.cameraActive && AppState.isSimMode) {
      isDragging = true;
      updateSimRobotPos(u, v);
    }
  }

  canvas.addEventListener('mousedown', handleCanvasTap);
  canvas.addEventListener('mousemove', (e) => {
    if (isDragging && !AppState.cameraActive && AppState.isSimMode) {
      const { u, v } = getNormalizedPointer(e);
      updateSimRobotPos(u, v);
    }
  });
  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  canvas.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      handleCanvasTap(e);
    },
    { passive: false }
  );
  canvas.addEventListener(
    'touchmove',
    (e) => {
      if (isDragging && !AppState.cameraActive && AppState.isSimMode) {
        e.preventDefault();
        const { u, v } = getNormalizedPointer(e);
        updateSimRobotPos(u, v);
      }
    },
    { passive: false }
  );
  canvas.addEventListener('touchend', () => {
    isDragging = false;
  });
}

function setupControls() {
  const btnStart = document.getElementById('btn-start-test');
  const btnStartText = document.getElementById('btn-start-test-text');
  const liveTimer = document.getElementById('live-timer-display');

  async function endActiveTest() {
    await finalizeTestRun(showToast, (record) => {
      selectedRecordId = record.id;
      renderRubricScorecard();
      renderHistoryList();
    });
  }

  btnStart.addEventListener('click', () => {
    if (!AppState.isTestRunning) {
      AppState.isTestRunning = true;
      AppState.testStartTime = Date.now();
      AppState.testDurationMs = 0;
      AppState.vision.distanceTraveledM = 0.0;
      AppState.vision.trajectory = [{ x: AppState.vision.robotPos.x, y: AppState.vision.robotPos.y }];
      AppState.vision.lastPos = { x: AppState.vision.robotPos.x, y: AppState.vision.robotPos.y };
      AppState.tracker.boxMissingSince = null;
      resetCargoBadge();
      resetRunMetrics();
      updateDockingAndChargingTimers(Date.now());

      btnStart.className =
        'px-4 sm:px-5 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white shadow-lg shadow-rose-600/30 transition-all flex items-center gap-2 shrink-0';
      btnStartText.textContent = 'End Test (Jury Stop)';
      startVideoRecording();
      showToast(`Test Started: ${TASK_DEFS[AppState.currentTask].badge}`, 'success');

      AppState.timerInterval = setInterval(() => {
        const elapsed = Date.now() - AppState.testStartTime;
        AppState.testDurationMs = elapsed;
        const m = Math.floor(elapsed / 60000)
          .toString()
          .padStart(2, '0');
        const s = Math.floor((elapsed % 60000) / 1000)
          .toString()
          .padStart(2, '0');
        const ms = Math.floor((elapsed % 1000) / 100);
        liveTimer.textContent = `${m}:${s}.${ms}`;

        // Auto-completion conditions per YTU EEF Spec 5.2
        if (AppState.currentTask === 'A' && elapsed >= SPEC_LIMITS.STATIC_BALANCE_TARGET_SEC * 1000) {
          endActiveTest();
        } else if (
          AppState.currentTask === 'C' &&
          AppState.telemetry.hwChargingStat === 1 &&
          AppState.runMetrics.chargingStableSince &&
          Date.now() - AppState.runMetrics.chargingStableSince >= 2000
        ) {
          endActiveTest();
        }
      }, 100);
    } else {
      endActiveTest();
    }
  });

  // Tracking mode toggle
  document.getElementById('mode-btn-aruco').addEventListener('click', () => {
    AppState.trackingMode = 'aruco';
    syncTrackingModeUI();
    saveArenaState();
    showToast('Switched vision tracker to ArUco 4x4 Tags', 'info');
  });
  document.getElementById('mode-btn-color').addEventListener('click', () => {
    AppState.trackingMode = 'color';
    syncTrackingModeUI();
    saveArenaState();
    showToast('Switched vision tracker to HSV Color Markers', 'info');
  });

  // Interactive calibration buttons
  document.getElementById('btn-calibrate-floor').addEventListener('click', () => {
    AppState.calibPointsPx = [];
    setInteractiveMode('calib_floor', 'Tap corner 1 of 4 (Top-Left) of your floor rectangle...');
  });
  document.getElementById('btn-pick-robot-color').addEventListener('click', () => {
    setInteractiveMode('pick_robot', 'Tap directly on the colored marker on top of the ROBOT...');
  });
  document.getElementById('btn-pick-box-color').addEventListener('click', () => {
    setInteractiveMode('pick_box', 'Tap directly on the ASPIRIN BOX / marker...');
  });
  document.getElementById('btn-place-dock').addEventListener('click', () => {
    setInteractiveMode('place_dock', 'Tap on the CHARGING STATION location on the arena...');
  });
  document.getElementById('btn-place-dock-aruco').addEventListener('click', () => {
    setInteractiveMode('place_dock', 'Tap on the CHARGING STATION location (or place Tag #2 on the dock)...');
  });
  document.getElementById('btn-cancel-interactive').addEventListener('click', () => {
    setInteractiveMode('none', '');
  });

  // Simulator controls
  document.getElementById('sim-cmd-fwd').addEventListener('click', () => {
    AppState.vision.robotPos.y = Math.max(0.05, AppState.vision.robotPos.y - 0.12);
    if (AppState.isTestRunning) AppState.vision.distanceTraveledM += 0.12;
    AppState.vision.robotHeadingDeg = -90;
    AppState.telemetry.motionState = 'MOVING';
    AppState.telemetry.directionLabel = 'FORWARD';
    AppState.runMetrics.directionsObserved.add('FORWARD');
    updateDockingAndChargingTimers(Date.now());
  });
  document.getElementById('sim-cmd-back').addEventListener('click', () => {
    AppState.vision.robotPos.y = Math.min(AppState.arena.depthM - 0.05, AppState.vision.robotPos.y + 0.12);
    if (AppState.isTestRunning) AppState.vision.distanceTraveledM += 0.12;
    AppState.vision.robotHeadingDeg = 90;
    AppState.telemetry.motionState = 'MOVING';
    AppState.telemetry.directionLabel = 'BACKWARD';
    AppState.runMetrics.directionsObserved.add('BACKWARD');
    updateDockingAndChargingTimers(Date.now());
  });
  document.getElementById('sim-cmd-left').addEventListener('click', () => {
    AppState.vision.robotHeadingDeg -= 30;
    AppState.telemetry.motionState = 'TURNING';
    AppState.telemetry.directionLabel = 'LEFT';
    AppState.runMetrics.directionsObserved.add('LEFT');
  });
  document.getElementById('sim-cmd-right').addEventListener('click', () => {
    AppState.vision.robotHeadingDeg += 30;
    AppState.telemetry.motionState = 'TURNING';
    AppState.telemetry.directionLabel = 'RIGHT';
    AppState.runMetrics.directionsObserved.add('RIGHT');
  });
  document.getElementById('sim-cmd-stop').addEventListener('click', () => {
    AppState.telemetry.motionState = 'STATIC_BALANCE';
    AppState.telemetry.directionLabel = 'STATIONARY';
  });
  document.getElementById('sim-cmd-chg').addEventListener('click', () => {
    AppState.telemetry.hwChargingStat = AppState.telemetry.hwChargingStat === 1 ? 0 : 1;
    updateDockingAndChargingTimers(Date.now());
    showToast(
      AppState.telemetry.hwChargingStat === 1 ? 'Simulated HW CHG Pin: HIGH (3.3V)' : 'Simulated HW CHG Pin: LOW (0V)',
      'info'
    );
  });
  document.getElementById('sim-cmd-drop-box').addEventListener('click', () => {
    triggerCargoDropped('Medication Box fell from robot! (Fail Trigger)');
  });

  document.getElementById('reset-arena-btn').addEventListener('click', () => {
    AppState.vision.robotPos = { x: 0.35, y: 1.1 };
    AppState.vision.distanceTraveledM = 0.0;
    AppState.vision.robotHeadingDeg = 0.0;
    AppState.vision.trajectory = [];
    AppState.telemetry.hwChargingStat = 0;
    AppState.telemetry.motionState = 'STATIC_BALANCE';
    AppState.telemetry.directionLabel = 'STATIONARY';
    resetCargoBadge();
    resetRunMetrics();
    showToast('Arena reset to starting position', 'info');
  });

  document.getElementById('toggle-sim-mode-btn').addEventListener('click', () => {
    AppState.isSimMode = !AppState.isSimMode;
    const btnLabel = document.getElementById('sim-mode-label');
    const simPanel = document.getElementById('sim-controls-panel');
    if (AppState.isSimMode) {
      AppState.linkType = 'sim';
      btnLabel.textContent = 'Sim: ON';
      if (!AppState.cameraActive) simPanel.classList.remove('hidden');
      showToast('Simulator telemetry enabled', 'info');
    } else {
      AppState.linkType = 'none';
      btnLabel.textContent = 'Sim: OFF';
      simPanel.classList.add('hidden');
      showToast('Live mode active. Tap Pair BLE to connect ESP32.', 'warning');
    }
  });

  document.getElementById('clear-log-btn').addEventListener('click', () => {
    const rawLog = document.getElementById('raw-telemetry-log');
    if (rawLog) rawLog.innerHTML = '<div class="text-slate-500">// Log cleared.</div>';
  });

  // Wireless Connection Buttons (Header quick button + Setup button)
  document.getElementById('btn-web-ble-connect').addEventListener('click', () => connectWebBluetooth(showToast));
  document.getElementById('btn-quick-ble')?.addEventListener('click', () => connectWebBluetooth(showToast));
  document.getElementById('btn-ws-connect').addEventListener('click', () => {
    const url = document.getElementById('ws-url-input').value.trim();
    connectWebSocket(url, showToast);
  });

  // PDF & JSON Exports
  document.getElementById('btn-export-pdf').addEventListener('click', () => {
    const rec = AppState.testHistory.find((r) => r.id === selectedRecordId) || AppState.testHistory[0];
    exportJuryPdf(rec, showToast);
  });

  document.getElementById('btn-export-json').addEventListener('click', () => {
    const clean = AppState.testHistory.map(({ videoUrl, ...rest }) => rest);
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(clean, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', `YTU_Evaluation_History_${Date.now()}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
    showToast('Raw JSON audit log exported', 'success');
  });

  // Printable ArUco Tags Modal
  const openModal = () => {
    renderPrintableArucoSheet();
    document.getElementById('aruco-modal').classList.remove('hidden');
  };
  document.getElementById('btn-open-print-tags').addEventListener('click', openModal);
  document.getElementById('btn-open-print-tags-calib').addEventListener('click', openModal);
  document.getElementById('btn-close-aruco-modal').addEventListener('click', () => {
    document.getElementById('aruco-modal').classList.add('hidden');
  });
  document.getElementById('btn-print-aruco-now').addEventListener('click', () => {
    window.print();
  });
}

function renderPrintableArucoSheet() {
  const grid = document.getElementById('aruco-print-grid');
  if (!grid || grid.childElementCount > 0) return;

  const ids = [0, 1, 2, 10, 11, 12, 13];
  grid.innerHTML = ids
    .map((id) => {
      const info = MARKER_DICT[id];
      const svg = createMarkerSvg(id, 150);
      return `
      <div class="p-4 border-2 border-slate-300 rounded-xl bg-white text-slate-900 flex flex-col items-center gap-2">
        <div class="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-700">▲ TOP / FORWARD ▲</div>
        <div class="border border-slate-200 p-1 bg-white">${svg}</div>
        <div class="text-sm font-bold font-mono">ID #${id} — ${info.name}</div>
        <div class="text-[11px] text-slate-600 text-center">${info.role}</div>
      </div>`;
    })
    .join('');
}

function setupCameraStream() {
  const btnCam = document.getElementById('camera-select-btn');
  const btnCamLabel = document.getElementById('camera-btn-label');
  const btnFlip = document.getElementById('btn-flip-camera');
  const video = document.getElementById('webcam-video');
  const srcLabel = document.getElementById('vision-source-label');
  const statusDot = document.getElementById('vision-status-dot');
  const trackPanel = document.getElementById('camera-tracking-panel');
  const simPanel = document.getElementById('sim-controls-panel');

  async function startCamera(facing) {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Camera API requires HTTPS (Vercel) or localhost.', 'warning');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      AppState.cameraStream = stream;
      video.srcObject = stream;
      await video.play();
      AppState.cameraActive = true;

      btnCamLabel.textContent = 'Stop Camera';
      btnCam.className =
        'px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-medium transition-colors flex items-center gap-1';
      btnFlip.classList.remove('hidden');
      srcLabel.textContent = `Live Camera (${facing === 'environment' ? 'Rear' : 'Front'})`;
      statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping';
      trackPanel.classList.remove('hidden');
      simPanel.classList.add('hidden');
      showToast(
        AppState.trackingMode === 'aruco'
          ? 'Camera live! Point at ArUco Tag #0 (Robot) & #1 (Aspirin Box).'
          : 'Camera live! Tap Pick Robot Color to lock tracker.',
        'success'
      );
    } catch (err) {
      showToast(`Camera access blocked (${err.name}). Open via HTTPS on Android Chrome.`, 'warning');
    }
  }

  function stopCamera() {
    if (AppState.cameraStream) {
      AppState.cameraStream.getTracks().forEach((t) => t.stop());
      AppState.cameraStream = null;
    }
    if (video) video.srcObject = null;
    AppState.cameraActive = false;
    btnCamLabel.textContent = 'Start Camera';
    btnCam.className =
      'px-2.5 py-1 rounded bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors flex items-center gap-1';
    btnFlip.classList.add('hidden');
    srcLabel.textContent = 'Simulator';
    statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
    trackPanel.classList.add('hidden');
    if (AppState.isSimMode) simPanel.classList.remove('hidden');
  }

  btnCam.addEventListener('click', () => {
    if (AppState.cameraActive) stopCamera();
    else startCamera(AppState.cameraFacingMode);
  });

  btnFlip.addEventListener('click', () => {
    AppState.cameraFacingMode = AppState.cameraFacingMode === 'environment' ? 'user' : 'environment';
    startCamera(AppState.cameraFacingMode);
  });
}

function setupCalibration() {
  document.getElementById('calib-width').value = AppState.arena.widthM.toFixed(2);
  document.getElementById('calib-depth').value = AppState.arena.depthM.toFixed(2);
  document.getElementById('calib-dock-radius').value = AppState.arena.dockRadiusM.toFixed(2);

  const hueSlider = document.getElementById('calib-hue-tol');
  const hueLabel = document.getElementById('hue-tol-value');
  hueSlider.addEventListener('input', () => {
    AppState.tracker.hueTolerance = parseInt(hueSlider.value, 10);
    hueLabel.textContent = `${AppState.tracker.hueTolerance}°`;
  });

  const modeSelect = document.getElementById('calib-tracking-mode');
  modeSelect.addEventListener('change', () => {
    AppState.trackingMode = modeSelect.value;
    syncTrackingModeUI();
    saveArenaState();
  });

  const autoRec = document.getElementById('toggle-auto-record');
  autoRec.addEventListener('change', () => {
    AppState.recorder.autoRecord = autoRec.checked;
  });

  document.getElementById('btn-reset-homography').addEventListener('click', () => {
    AppState.calibPointsPx = [];
    AppState.homographyMatrix = null;
    AppState.invHomographyMatrix = null;
    saveArenaState();
    showToast('4-Corner floor homography reset', 'info');
  });

  document.getElementById('save-calib-btn').addEventListener('click', () => {
    AppState.arena.widthM = parseFloat(document.getElementById('calib-width').value) || 1.5;
    AppState.arena.depthM = parseFloat(document.getElementById('calib-depth').value) || 1.5;
    AppState.arena.dockRadiusM = parseFloat(document.getElementById('calib-dock-radius').value) || 0.3;
    if (AppState.calibPointsPx.length === 4) {
      const res = computeFloorHomographies(AppState.calibPointsPx, AppState.arena.widthM, AppState.arena.depthM);
      AppState.homographyMatrix = res.homographyMatrix;
      AppState.invHomographyMatrix = res.invHomographyMatrix;
    }
    saveArenaState();
    showToast('Arena calibration saved locally', 'success');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      const badge = document.getElementById('pwa-offline-badge');
      if (badge) {
        badge.textContent = 'PWA Ready';
        badge.classList.remove('hidden');
      }
    } catch (_) {
      // SW registration may fail on file:// protocol; works on HTTPS/localhost
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadSavedState();
  if (AppState.calibPointsPx.length === 4) {
    const res = computeFloorHomographies(AppState.calibPointsPx, AppState.arena.widthM, AppState.arena.depthM);
    AppState.homographyMatrix = res.homographyMatrix;
    AppState.invHomographyMatrix = res.invHomographyMatrix;
  }

  setupTabs();
  setupTaskSelection();
  initTiltChart();
  setupCanvasInteractions();
  setupControls();
  setupCameraStream();
  setupCalibration();
  syncTrackingModeUI();
  renderRubricScorecard();
  renderHistoryList();

  startArenaRenderer({
    onCargoDrop: (msg) => triggerCargoDropped(msg),
    onAutoCalibrated: () => showToast('Auto-calibrated floor homography from ArUco tags #10-#13!', 'success')
  });

  startWatchdogTimer();
  startSimulatorLoop();
  registerServiceWorker();

  if (AppState.testHistory.length === 0) {
    updateQrCode('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  }
});
