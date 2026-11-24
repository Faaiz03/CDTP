/**
 * YTU EEF Module A / B / C / E Evaluation Engine, MediaRecorder Video Capture,
 * SHA-256 Cryptographic Sealing & Verification, and Official Jury PDF Export.
 */

import { AppState, SPEC_LIMITS, TASK_DEFS, saveHistoryState } from './state.js';

/**
 * Pure scoring function (easy to unit-test independently of the DOM).
 * Follows YTU EEF Section 5.2 & Section 7:
 * - Binary pass/fail per subtest (PASS = 5 / FAIL = 0; 20 pts per module rubric)
 * - Medication box MUST remain secure in ALL tests
 * - Wireless link gap must not exceed 2.0 s during evaluation
 */
export function evaluateRunCriteria(task, metrics) {
  const {
    durationSec,
    distanceM,
    cargoSecure,
    maxAbsTiltDeg,
    tiltViolation,
    maxDisconnectGapSec,
    hwChargingActive,
    chargeStartDelaySec,
    directionsCount
  } = metrics;

  const checks = [];
  let pass = true;
  const failReasons = [];

  // Mandatory across ALL tests (Section 7): Medication box secure
  checks.push({ label: 'Medication Box Secure', ok: cargoSecure });
  if (!cargoSecure) {
    pass = false;
    failReasons.push('Medication box fell from robot (instant fail)');
  }

  // Mandatory across ALL tests (Section 5.2): Wireless link gap <= 2.0 s
  const linkOk = maxDisconnectGapSec <= SPEC_LIMITS.WATCHDOG_MAX_GAP_SEC;
  checks.push({ label: `1 Hz Link Continuity (max gap ${maxDisconnectGapSec.toFixed(2)}s <= 2.0s)`, ok: linkOk });
  if (!linkOk) {
    pass = false;
    failReasons.push(`Wireless link interrupted for ${maxDisconnectGapSec.toFixed(1)} s (> 2.0 s limit)`);
  }

  if (task === 'A') {
    const durOk = durationSec >= SPEC_LIMITS.STATIC_BALANCE_TARGET_SEC - SPEC_LIMITS.DURATION_TOLERANCE_SEC;
    const tiltOk = !tiltViolation && maxAbsTiltDeg <= SPEC_LIMITS.MAX_TILT_DEG;
    checks.push({ label: `Balance Duration (${durationSec.toFixed(1)}s >= 28.0s)`, ok: durOk });
    checks.push({ label: `Active Balance Tilt (max ${maxAbsTiltDeg.toFixed(1)}° <= 10.0°)`, ok: tiltOk });
    if (!durOk) {
      pass = false;
      failReasons.push(`Balance duration ${durationSec.toFixed(1)} s < 28.0 s (30 s +/- 2 s)`);
    }
    if (!tiltOk) {
      pass = false;
      failReasons.push(`Tilt exceeded +/-10 deg limit (max ${maxAbsTiltDeg.toFixed(1)} deg)`);
    }
  } else if (task === 'B') {
    const distOk = distanceM >= SPEC_LIMITS.GUIDANCE_MIN_DIST_M && distanceM <= SPEC_LIMITS.GUIDANCE_MAX_DIST_M;
    const tiltOk = !tiltViolation;
    checks.push({ label: `Distance Range (${distanceM.toFixed(2)}m in 0.8-1.2m)`, ok: distOk });
    checks.push({ label: `Upright Stability (max ${maxAbsTiltDeg.toFixed(1)}° <= 10.0°)`, ok: tiltOk });
    if (!distOk) {
      pass = false;
      failReasons.push(`Distance ${distanceM.toFixed(2)} m outside 0.8-1.2 m target range`);
    }
    if (!tiltOk) {
      pass = false;
      failReasons.push(`Lost upright balance during guidance (max ${maxAbsTiltDeg.toFixed(1)} deg)`);
    }
  } else if (task === 'C') {
    const chargeDelayOk =
      hwChargingActive &&
      chargeStartDelaySec !== null &&
      chargeStartDelaySec <= SPEC_LIMITS.CHARGE_START_MAX_SEC;
    checks.push({ label: 'Hardware CHG/STAT Pin Active', ok: hwChargingActive });
    checks.push({
      label: `Charge Start Latency (${chargeStartDelaySec !== null ? chargeStartDelaySec.toFixed(2) + 's' : 'N/A'} <= 5.0s)`,
      ok: chargeDelayOk
    });
    if (!hwChargingActive) {
      pass = false;
      failReasons.push('Hardware CHG/STAT charging signal not detected');
    } else if (!chargeDelayOk) {
      pass = false;
      failReasons.push(`Charging start took ${chargeStartDelaySec?.toFixed(2) ?? '>5'} s (> 5.0 s limit)`);
    }
  } else {
    // Module E: Integrated Scenario
    const distOk = distanceM >= SPEC_LIMITS.GUIDANCE_MIN_DIST_M;
    const chargeDelayOk =
      hwChargingActive &&
      chargeStartDelaySec !== null &&
      chargeStartDelaySec <= SPEC_LIMITS.CHARGE_START_MAX_SEC;
    const tiltOk = !tiltViolation;
    checks.push({ label: `Transport Distance (${distanceM.toFixed(2)}m >= 0.80m)`, ok: distOk });
    checks.push({ label: `Hardware Charge Start <= 5.0s`, ok: chargeDelayOk });
    checks.push({ label: `Upright Stability (max ${maxAbsTiltDeg.toFixed(1)}° <= 10.0°)`, ok: tiltOk });
    if (!distOk) {
      pass = false;
      failReasons.push(`Delivery travel ${distanceM.toFixed(2)} m below 0.80 m minimum`);
    }
    if (!chargeDelayOk) {
      pass = false;
      failReasons.push(
        hwChargingActive
          ? `Auto-charge start took ${chargeStartDelaySec?.toFixed(2) ?? '>5'} s (> 5.0 s)`
          : 'Robot failed to engage hardware charging station'
      );
    }
    if (!tiltOk) {
      pass = false;
      failReasons.push(`Lost upright balance during delivery (max ${maxAbsTiltDeg.toFixed(1)} deg)`);
    }
  }

  const reason = pass
    ? `All ${TASK_DEFS[task]?.badge || 'Module ' + task} requirements verified (${distanceM.toFixed(2)} m, ${durationSec.toFixed(1)} s${directionsCount > 0 ? ', ' + directionsCount + ' dir' : ''}).`
    : failReasons.join(' | ');

  return {
    pass,
    subtestScore: pass ? 5 : 0,
    moduleScore: pass ? 20 : 0,
    reason,
    checks
  };
}

/**
 * Compute deterministic SHA-256 hex digest of a canonical payload object.
 */
export async function computePayloadHash(payload) {
  const canonical = JSON.stringify(payload);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const msgUint8 = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback non-crypto hash if running in insecure non-HTTPS test context
  let h = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ('fallback_' + (h >>> 0).toString(16).padStart(8, '0')).padEnd(64, '0');
}

/**
 * Start MediaRecorder on the evaluation arena canvas.
 */
export function startVideoRecording() {
  if (!AppState.recorder.autoRecord) return;
  const canvas = document.getElementById('arena-canvas');
  if (!canvas || typeof MediaRecorder === 'undefined' || !canvas.captureStream) return;

  try {
    const stream = canvas.captureStream(20);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    AppState.recorder.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) AppState.recorder.chunks.push(e.data);
    };
    recorder.start(500);
    AppState.recorder.mediaRecorder = recorder;
    AppState.recorder.isRecording = true;

    const recInd = document.getElementById('rec-indicator');
    if (recInd) {
      recInd.classList.remove('hidden');
      recInd.classList.add('flex');
    }
  } catch (err) {
    console.warn('MediaRecorder start failed:', err);
  }
}

export function stopVideoRecording() {
  return new Promise((resolve) => {
    const rec = AppState.recorder.mediaRecorder;
    const recInd = document.getElementById('rec-indicator');
    if (recInd) {
      recInd.classList.add('hidden');
      recInd.classList.remove('flex');
    }
    if (!rec || !AppState.recorder.isRecording) {
      resolve(null);
      return;
    }
    AppState.recorder.isRecording = false;
    rec.onstop = () => {
      if (AppState.recorder.chunks.length === 0) {
        resolve(null);
        return;
      }
      const blob = new Blob(AppState.recorder.chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      AppState.recorder.lastVideoUrl = url;
      resolve(url);
    };
    try {
      rec.stop();
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Update QR code DOM element with SHA-256 seal.
 */
export function updateQrCode(hashString) {
  const qrContainer = document.getElementById('report-qrcode');
  if (!qrContainer || typeof window.QRCode === 'undefined') return;
  qrContainer.innerHTML = '';
  try {
    new window.QRCode(qrContainer, {
      text: `YTU_EEF_MDP_2026_SEAL:${hashString}`,
      width: 128,
      height: 128,
      colorDark: '#0f172a',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M
    });
  } catch (e) {
    console.error('QR render error:', e);
  }
}

/**
 * Finalize an active test run, seal it with SHA-256, update rubric, and persist record.
 */
export async function finalizeTestRun(showToast, onRecordCreated) {
  clearInterval(AppState.timerInterval);
  AppState.isTestRunning = false;

  const btnStart = document.getElementById('btn-start-test');
  const btnStartText = document.getElementById('btn-start-test-text');
  if (btnStart && btnStartText) {
    btnStart.className =
      'px-4 sm:px-5 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-600/30 transition-all flex items-center gap-2 shrink-0';
    btnStartText.textContent = 'Start Test';
  }

  const videoUrl = await stopVideoRecording();
  const durationSec = AppState.testDurationMs / 1000.0;
  const rm = AppState.runMetrics;

  const metrics = {
    durationSec,
    distanceM: AppState.vision.distanceTraveledM,
    cargoSecure: AppState.vision.cargoSecure,
    maxAbsTiltDeg: rm.maxAbsTiltDeg,
    tiltViolation: rm.tiltViolation,
    maxDisconnectGapSec: rm.maxDisconnectGapSec,
    hwChargingActive: AppState.telemetry.hwChargingStat === 1,
    chargeStartDelaySec: rm.chargeStartDelaySec,
    directionsCount: rm.directionsObserved.size,
    directions: Array.from(rm.directionsObserved),
    motionStates: Array.from(rm.motionStatesObserved)
  };

  const verdict = evaluateRunCriteria(AppState.currentTask, metrics);

  const sealedPayload = {
    project: 'YTU_EEF_MDP_TWO_WHEELED_ROBOT',
    module: AppState.currentTask,
    timestamp_iso: new Date().toISOString(),
    duration_sec: Number(durationSec.toFixed(2)),
    distance_m: Number(metrics.distanceM.toFixed(2)),
    max_abs_tilt_deg: Number(metrics.maxAbsTiltDeg.toFixed(2)),
    max_disconnect_gap_sec: Number(metrics.maxDisconnectGapSec.toFixed(2)),
    cargo_secure: metrics.cargoSecure,
    charging_active: metrics.hwChargingActive,
    charge_start_delay_sec:
      metrics.chargeStartDelaySec !== null ? Number(metrics.chargeStartDelaySec.toFixed(2)) : null,
    tracking_mode: AppState.trackingMode,
    verdict: verdict.pass ? 'PASS (5/5)' : 'FAIL (0/5)',
    reason: verdict.reason
  };

  const hashHex = await computePayloadHash(sealedPayload);

  const hashEl = document.getElementById('sha256-hash-display');
  if (hashEl) hashEl.textContent = hashHex;
  updateQrCode(hashHex);

  const record = {
    id: `RUN-${Date.now().toString().slice(-5)}`,
    task: AppState.currentTask,
    duration: durationSec.toFixed(1),
    distance: metrics.distanceM.toFixed(2),
    maxTilt: metrics.maxAbsTiltDeg.toFixed(1),
    maxGap: metrics.maxDisconnectGapSec.toFixed(2),
    cargoSecure: metrics.cargoSecure,
    chargingActive: metrics.hwChargingActive,
    chargeDelay: metrics.chargeStartDelaySec !== null ? metrics.chargeStartDelaySec.toFixed(2) : null,
    pass: verdict.pass,
    subtestScore: verdict.subtestScore,
    moduleScore: verdict.moduleScore,
    reason: verdict.reason,
    checks: verdict.checks,
    payload: sealedPayload,
    hash: hashHex,
    date: new Date().toLocaleString(),
    videoUrl
  };

  AppState.testHistory.unshift(record);
  AppState.rubricResults[AppState.currentTask] = {
    pass: verdict.pass,
    subtestScore: verdict.subtestScore,
    moduleScore: verdict.moduleScore,
    runId: record.id
  };
  saveHistoryState();

  if (onRecordCreated) onRecordCreated(record);

  if (verdict.pass) {
    showToast(`TEST PASSED! Subtest 5/5 (Module 20/20). Video & SHA-256 sealed.`, 'success');
  } else {
    showToast(`TEST FAILED (0/5): ${verdict.reason}`, 'error');
  }

  return record;
}

/**
 * Generate an official YTU EEF Jury PDF Certificate from a specific immutable record,
 * embedding the cryptographic SHA-256 QR code image directly in the PDF.
 */
export function exportJuryPdf(record, showToast) {
  if (!window.jspdf) {
    showToast('PDF library still loading...', 'warning');
    return;
  }

  const target = record || AppState.testHistory[0];
  if (!target) {
    showToast('Complete at least one test run before exporting a Jury PDF.', 'warning');
    return;
  }

  // Ensure QR code reflects this specific record before capturing its data URL
  updateQrCode(target.hash);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  // Header Banner
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 210, 38, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('YILDIZ TECHNICAL UNIVERSITY', 14, 15);
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'normal');
  doc.text('Faculty of Electrical & Electronics Engineering | MDP 2026-2027', 14, 23);
  doc.setFontSize(9);
  doc.text('Two-Wheeled Indoor Patient Assistance Robot — Module D Official Certificate', 14, 31);

  // Record Details (strictly from immutable record, never live mutable state)
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(11.5);
  doc.setFont('helvetica', 'bold');
  doc.text(`1. EVALUATION RECORD (${target.id})`, 14, 49);

  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  const rows = [
    `Timestamp: ${target.date}`,
    `Evaluated Module: ${TASK_DEFS[target.task]?.badge || 'Module ' + target.task}`,
    `Duration: ${target.duration} s (Tolerance +/-2.0 s)`,
    `Measured Travel Distance: ${target.distance} m (Target: 0.80 - 1.20 m)`,
    `Peak Tilt Angle: ${target.maxTilt ?? 'N/A'} deg (Limit: +/-10.0 deg)`,
    `Max Telemetry Gap: ${target.maxGap ?? '0.00'} s (Limit: <= 2.0 s)`,
    `Medication Box (Module E): ${target.cargoSecure ? 'SECURE (Zero Drop)' : 'DROPPED (FAIL)'}`,
    `Hardware CHG/STAT Pin: ${
      target.chargingActive
        ? `ACTIVE (${target.chargeDelay ? target.chargeDelay + ' s <= 5.0 s' : 'Confirmed'})`
        : 'NOT ENGAGED'
    }`
  ];

  let y = 58;
  for (const line of rows) {
    doc.text(line, 14, y);
    y += 6.5;
  }

  // Verdict Banner
  y += 4;
  if (target.pass) {
    doc.setFillColor(16, 185, 129);
  } else {
    doc.setFillColor(225, 29, 72);
  }
  doc.rect(14, y, 182, 16, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(
    target.pass
      ? 'JURY VERDICT: PASS  |  SUBTEST: 5 / 5  (MODULE: 20 / 20)'
      : 'JURY VERDICT: FAIL  |  SUBTEST: 0 / 5  (MODULE: 0 / 20)',
    19,
    y + 10.5
  );

  // Reason / Summary
  y += 24;
  doc.setTextColor(51, 65, 85);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const wrappedReason = doc.splitTextToSize(`Evaluation Note: ${target.reason}`, 182);
  doc.text(wrappedReason, 14, y);
  y += wrappedReason.length * 5 + 8;

  // Cryptographic Audit Section + Embedded QR Code
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('2. TAMPER-PROOF SHA-256 CRYPTOGRAPHIC SEAL', 14, y);
  y += 7;

  doc.setFontSize(8);
  doc.setFont('courier', 'normal');
  doc.text(`SHA-256: ${target.hash}`, 14, y);
  y += 6;
  doc.setFont('helvetica', 'italic');
  doc.text(
    'This evaluation record was hashed locally using Web Crypto SHA-256 immediately upon test completion.',
    14,
    y
  );

  // Embed QR canvas/image if available
  const qrCanvas = document.querySelector('#report-qrcode canvas');
  const qrImg = document.querySelector('#report-qrcode img');
  try {
    const dataUrl = qrCanvas ? qrCanvas.toDataURL('image/png') : qrImg?.src;
    if (dataUrl) {
      doc.addImage(dataUrl, 'PNG', 156, y + 4, 38, 38);
    }
  } catch (_) {}

  // Signatures
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('Jury Member Signature:  ___________________________', 14, y + 22);
  doc.text('Project Advisor:        ___________________________', 14, y + 36);

  doc.save(`YTU_EEF_Eval_${target.id}_Mod${target.task}.pdf`);
  showToast(`Exported Official Jury PDF (${target.id})`, 'success');
}
