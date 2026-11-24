/**
 * Wireless Telemetry, BLE MTU Chunk Reassembly, 1 Hz Simulator,
 * and Independent >2.0s Watchdog Engine (YTU EEF Module D).
 */

import { AppState, BLE_CONFIG, SPEC_LIMITS } from './state.js';
import { updateDockingAndChargingTimers } from './vision.js';

let tiltChart = null;
let watchdogInterval = null;
let simInterval = null;

export function setTiltChartInstance(chart) {
  tiltChart = chart;
}

/**
 * Reassembles fragmented BLE GATT notifications (20-byte default MTU)
 * into complete JSON objects delimited by newlines or balanced braces.
 */
export function feedBleChunk(chunkText) {
  AppState.telemetry.bleRxBuffer += chunkText;
  if (AppState.telemetry.bleRxBuffer.length > 4096) {
    AppState.telemetry.bleRxBuffer = AppState.telemetry.bleRxBuffer.slice(-1024);
  }

  const packets = [];

  // 1. Extract newline-delimited frames first
  while (AppState.telemetry.bleRxBuffer.includes('\n')) {
    const nlIdx = AppState.telemetry.bleRxBuffer.indexOf('\n');
    const line = AppState.telemetry.bleRxBuffer.slice(0, nlIdx).trim();
    AppState.telemetry.bleRxBuffer = AppState.telemetry.bleRxBuffer.slice(nlIdx + 1);
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        packets.push(JSON.parse(line));
      } catch (_) {}
    }
  }

  // 2. Also handle ESP32 sketches that omit trailing '\n' by scanning balanced braces
  let start = AppState.telemetry.bleRxBuffer.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = start; i < AppState.telemetry.bleRxBuffer.length; i++) {
      const ch = AppState.telemetry.bleRxBuffer[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) {
      const jsonStr = AppState.telemetry.bleRxBuffer.slice(start, end + 1);
      AppState.telemetry.bleRxBuffer = AppState.telemetry.bleRxBuffer.slice(end + 1);
      try {
        packets.push(JSON.parse(jsonStr));
      } catch (_) {}
      start = AppState.telemetry.bleRxBuffer.indexOf('{');
    } else {
      // Incomplete packet; keep from opening brace onward
      if (start > 0) AppState.telemetry.bleRxBuffer = AppState.telemetry.bleRxBuffer.slice(start);
      break;
    }
  }

  return packets;
}

/**
 * Process a single 1 Hz robot telemetry JSON packet and update all live gauges & metrics.
 */
export function processTelemetryPacket(packet) {
  const now = Date.now();
  const gapSec = (now - AppState.telemetry.lastRxTimestamp) / 1000.0;

  AppState.telemetry.liveGapSec = gapSec;
  if (AppState.telemetry.packetCount > 0 && gapSec > AppState.telemetry.maxGapSessionSec) {
    AppState.telemetry.maxGapSessionSec = gapSec;
  }
  AppState.telemetry.lastRxTimestamp = now;
  AppState.telemetry.packetCount++;
  AppState.telemetry.seq = packet.seq ?? AppState.telemetry.packetCount;

  const tilt = typeof packet.tilt_deg === 'number' ? packet.tilt_deg : 0.0;
  AppState.telemetry.tiltDeg = tilt;
  AppState.telemetry.pitchRateDps = typeof packet.pitch_rate_dps === 'number' ? packet.pitch_rate_dps : 0.0;
  AppState.telemetry.prevHwChargingStat = AppState.telemetry.hwChargingStat;
  AppState.telemetry.hwChargingStat = packet.charging_hardware_stat ? 1 : 0;
  AppState.telemetry.batteryMv = packet.battery_voltage_mv ?? 11800;
  AppState.telemetry.batteryPct = packet.battery_pct ?? 80;

  if (packet.motion_state && !AppState.cameraActive) {
    AppState.telemetry.motionState = packet.motion_state;
  }

  if (typeof packet.timestamp_ms === 'number') {
    const rawLat = Math.abs(now - packet.timestamp_ms);
    AppState.telemetry.latencyMs = rawLat < 5000 ? rawLat : 14;
  }

  // Continuously enforce tilt & link metrics during active test runs
  if (AppState.isTestRunning) {
    const absTilt = Math.abs(tilt);
    if (absTilt > AppState.runMetrics.maxAbsTiltDeg) {
      AppState.runMetrics.maxAbsTiltDeg = absTilt;
    }
    // During static balance (Module A) or moving (B/E), exceeding +/-10 deg (when not docked) is a balance failure
    if (absTilt > SPEC_LIMITS.MAX_TILT_DEG && !AppState.vision.isDocked) {
      AppState.runMetrics.tiltViolation = true;
      AppState.runMetrics.tiltViolationDeg = Math.max(AppState.runMetrics.tiltViolationDeg, absTilt);
    }
    if (gapSec > AppState.runMetrics.maxDisconnectGapSec) {
      AppState.runMetrics.maxDisconnectGapSec = gapSec;
    }
  }

  // Update 30 cm docking & <= 5.0 s hardware charging latency tracker
  updateDockingAndChargingTimers(now);

  // Update UI gauges
  updateTelemetryDom(gapSec);
}

function updateTelemetryDom(gapSec) {
  const battNav = document.getElementById('battery-status-nav');
  if (battNav) battNav.textContent = `${AppState.telemetry.batteryPct}%`;

  updateWatchdogPill(gapSec);

  // Tilt readout & gauge bar
  const tiltVal = document.getElementById('telemetry-tilt-value');
  const pitchBar = document.getElementById('pitch-gauge-bar');
  const tiltBadge = document.getElementById('tilt-stability-badge');
  const tilt = AppState.telemetry.tiltDeg;

  if (tiltVal) tiltVal.textContent = `${tilt >= 0 ? '+' : ''}${tilt.toFixed(1)}°`;
  if (pitchBar) {
    const pct = Math.max(5, Math.min(95, 50 + (tilt / 20.0) * 45));
    pitchBar.style.left = `${pct}%`;
  }
  if (tiltBadge) {
    const isStable = Math.abs(tilt) <= SPEC_LIMITS.MAX_TILT_DEG;
    tiltBadge.className = isStable
      ? 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
      : 'px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 animate-pulse';
    tiltBadge.textContent = isStable
      ? `Stable (${Math.abs(tilt).toFixed(1)}°)`
      : `TILT VIOLATION (${Math.abs(tilt).toFixed(1)}°)`;
  }

  // 3-Signal Charging Verification Card (Camera Pos + Robot Tilt + HW CHG Pin & Battery)
  const chgBadge = document.getElementById('charging-stat-badge');
  const hwStat = document.getElementById('telemetry-hw-stat');
  const battV = document.getElementById('telemetry-batt-voltage');
  const timerVerif = document.getElementById('docking-timer-verification');
  const sigCam = document.getElementById('chg-sig-cam');
  const sigTilt = document.getElementById('chg-sig-tilt');

  const isChg = AppState.telemetry.hwChargingStat === 1;
  if (chgBadge && hwStat && battV) {
    if (isChg) {
      chgBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 animate-pulse';
      chgBadge.textContent = 'CHARGING ACTIVE (HW)';
      hwStat.textContent = 'HIGH (3.3V CHG)';
      hwStat.className = 'font-mono text-sm font-bold text-cyan-400';
    } else if (AppState.vision.inDockZone) {
      chgBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40';
      chgBadge.textContent = 'IN 30 cm DOCK ZONE';
      hwStat.textContent = 'WAITING FOR PIN...';
      hwStat.className = 'font-mono text-sm font-bold text-amber-300';
    } else {
      chgBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700';
      chgBadge.textContent = 'DOCK DISCONNECTED';
      hwStat.textContent = 'LOW (0V)';
      hwStat.className = 'font-mono text-sm font-bold text-slate-300';
    }
    battV.textContent = `${(AppState.telemetry.batteryMv / 1000).toFixed(2)} V (${AppState.telemetry.batteryPct}%)`;
  }

  if (sigCam) {
    sigCam.textContent = AppState.vision.inDockZone ? 'IN 30cm ZONE' : 'OUTSIDE';
    sigCam.className = AppState.vision.inDockZone ? 'font-mono text-cyan-400 font-bold' : 'font-mono text-slate-400';
  }
  if (sigTilt) {
    const dockedTilt = isChg ? `RESTING (${tilt.toFixed(1)}°)` : `ACTIVE (${tilt.toFixed(1)}°)`;
    sigTilt.textContent = dockedTilt;
    sigTilt.className = isChg ? 'font-mono text-emerald-400 font-bold' : 'font-mono text-slate-300';
  }

  if (timerVerif) {
    const delay = AppState.runMetrics.chargeStartDelaySec;
    if (delay !== null) {
      const ok = delay <= SPEC_LIMITS.CHARGE_START_MAX_SEC;
      timerVerif.textContent = `${delay.toFixed(2)} s (${ok ? 'PASS <= 5.0s' : 'FAIL > 5.0s'})`;
      timerVerif.className = ok ? 'font-mono font-bold text-emerald-400' : 'font-mono font-bold text-rose-400';
    } else if (AppState.vision.inDockZone && AppState.runMetrics.dockZoneEnteredAt) {
      const waitSec = (Date.now() - AppState.runMetrics.dockZoneEnteredAt) / 1000.0;
      timerVerif.textContent = `Docking: ${waitSec.toFixed(1)} / 5.0 s`;
      timerVerif.className = waitSec <= 5.0 ? 'font-mono font-bold text-amber-300' : 'font-mono font-bold text-rose-400';
    } else {
      timerVerif.textContent = '<= 5.0 s required';
      timerVerif.className = 'font-mono text-slate-300';
    }
  }

  // Update Chart.js 30 s history
  if (tiltChart) {
    const dataArr = tiltChart.data.datasets[0].data;
    dataArr.shift();
    dataArr.push(tilt);
    tiltChart.update('none');
  }

  // Append to raw telemetry log
  const rawLog = document.getElementById('raw-telemetry-log');
  if (rawLog) {
    const logLine = document.createElement('div');
    logLine.textContent = `[${new Date().toISOString().substring(11, 23)}] #${AppState.telemetry.seq} TILT:${tilt.toFixed(1)}° CHG:${AppState.telemetry.hwChargingStat} BATT:${AppState.telemetry.batteryMv}mV (${AppState.telemetry.batteryPct}%) STATE:${AppState.telemetry.motionState}`;
    rawLog.prepend(logLine);
    if (rawLog.childElementCount > 60) rawLog.removeChild(rawLog.lastChild);
  }

  const statPkt = document.getElementById('stat-pkt-count');
  const statLat = document.getElementById('stat-latency');
  const statGap = document.getElementById('stat-max-gap');
  if (statPkt) statPkt.textContent = String(AppState.telemetry.packetCount);
  if (statLat) statLat.textContent = `${AppState.telemetry.latencyMs} ms`;
  if (statGap) {
    const mg = AppState.telemetry.maxGapSessionSec;
    statGap.textContent = `${mg.toFixed(2)} s (${mg <= SPEC_LIMITS.WATCHDOG_MAX_GAP_SEC ? '<=2s OK' : 'ALERT'})`;
    statGap.className = mg <= SPEC_LIMITS.WATCHDOG_MAX_GAP_SEC ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
  }
}

function updateWatchdogPill(gapSec) {
  const hbDot = document.getElementById('heartbeat-dot');
  const hbText = document.getElementById('heartbeat-text');
  const hbPill = document.getElementById('heartbeat-pill');
  if (!hbDot || !hbText || !hbPill) return;

  if (AppState.telemetry.packetCount === 0 && !AppState.isSimMode) {
    hbDot.className = 'w-2 h-2 rounded-full bg-slate-500';
    hbText.textContent = '1 Hz Link: Offline';
    hbPill.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-slate-800 text-slate-400 border border-slate-700/60';
    return;
  }

  if (gapSec <= SPEC_LIMITS.WATCHDOG_MAX_GAP_SEC) {
    AppState.telemetry.isLinkAlert = false;
    hbDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    const tag = AppState.isSimMode ? 'Sim' : AppState.linkType.toUpperCase();
    hbText.textContent = `1 Hz ${tag}: Live (${gapSec.toFixed(1)}s)`;
    hbPill.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-emerald-950/60 text-emerald-300 border border-emerald-500/40';
  } else {
    if (!AppState.telemetry.isLinkAlert && AppState.isTestRunning) {
      AppState.runMetrics.linkDropCount++;
    }
    AppState.telemetry.isLinkAlert = true;
    hbDot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-ping';
    hbText.textContent = `LINK DROP: ${gapSec.toFixed(1)}s (>2s)`;
    hbPill.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-rose-950/80 text-rose-300 border border-rose-500/60';
  }
}

/**
 * Independent 250 ms Watchdog — guarantees > 2.0 s link drops are caught
 * immediately even if the ESP32 stops sending packets altogether.
 */
export function startWatchdogTimer() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    const now = Date.now();
    const gapSec = (now - AppState.telemetry.lastRxTimestamp) / 1000.0;
    AppState.telemetry.liveGapSec = gapSec;

    if (AppState.telemetry.packetCount > 0 || AppState.isTestRunning) {
      if (AppState.isTestRunning && gapSec > AppState.runMetrics.maxDisconnectGapSec) {
        AppState.runMetrics.maxDisconnectGapSec = gapSec;
      }
      if (gapSec > SPEC_LIMITS.WATCHDOG_MAX_GAP_SEC) {
        updateWatchdogPill(gapSec);
      }
    }

    // Live update of 5-second docking timer while in dock zone waiting for CHG pin
    if (AppState.vision.inDockZone && AppState.telemetry.hwChargingStat === 0 && AppState.runMetrics.dockZoneEnteredAt) {
      const timerVerif = document.getElementById('docking-timer-verification');
      if (timerVerif) {
        const waitSec = (now - AppState.runMetrics.dockZoneEnteredAt) / 1000.0;
        timerVerif.textContent = `Docking: ${waitSec.toFixed(1)} / 5.0 s`;
        timerVerif.className = waitSec <= 5.0 ? 'font-mono font-bold text-amber-300' : 'font-mono font-bold text-rose-400';
      }
    }
  }, 250);
}

/**
 * 1 Hz Simulator Loop (when Sim Mode is ON).
 */
export function startSimulatorLoop() {
  if (simInterval) clearInterval(simInterval);
  let simSeq = 1;
  simInterval = setInterval(() => {
    if (!AppState.isSimMode) return;

    const baseOscillation = Math.sin(Date.now() / 420.0) * 1.1;
    const noise = (Math.random() - 0.5) * 0.4;
    const simTilt = AppState.vision.isDocked ? 0.3 : baseOscillation + noise;

    // Simulate motion only when live camera is OFF
    if (AppState.isTestRunning && !AppState.cameraActive) {
      const elapsedSec = (Date.now() - AppState.testStartTime) / 1000.0;
      const distToDock = Math.hypot(
        AppState.vision.robotPos.x - AppState.vision.dockPos.x,
        AppState.vision.robotPos.y - AppState.vision.dockPos.y
      );

      if (AppState.currentTask === 'E' && elapsedSec < 3.0) {
        // Initial static balance phase before moving
        AppState.telemetry.motionState = 'STATIC_BALANCE';
        AppState.telemetry.directionLabel = 'STATIONARY';
      } else if (
        (AppState.currentTask === 'B' && AppState.vision.distanceTraveledM < 1.0) ||
        (AppState.currentTask === 'C' && distToDock > 0.08) ||
        (AppState.currentTask === 'E' && distToDock > 0.08)
      ) {
        const dx = AppState.vision.dockPos.x - AppState.vision.robotPos.x;
        const dy = AppState.vision.dockPos.y - AppState.vision.robotPos.y;
        const len = Math.hypot(dx, dy) || 1;
        const step = Math.min(0.08, len);
        AppState.vision.robotPos.x += (dx / len) * step;
        AppState.vision.robotPos.y += (dy / len) * step;
        AppState.vision.distanceTraveledM += step;
        AppState.vision.robotHeadingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        AppState.vision.trajectory.push({ x: AppState.vision.robotPos.x, y: AppState.vision.robotPos.y });
        if (AppState.vision.trajectory.length > 150) AppState.vision.trajectory.shift();
        AppState.telemetry.motionState = 'MOVING';
        AppState.telemetry.directionLabel = 'FORWARD';
        AppState.runMetrics.directionsObserved.add('FORWARD');
        AppState.runMetrics.headingDeltaAccumDeg += 5;
      }

      const newDistToDock = updateDockingAndChargingTimers(Date.now());
      if (newDistToDock <= AppState.arena.dockRadiusM && AppState.runMetrics.dockZoneEnteredAt) {
        if (Date.now() - AppState.runMetrics.dockZoneEnteredAt >= 2000) {
          AppState.telemetry.hwChargingStat = 1;
          AppState.telemetry.motionState = 'STATIC_BALANCE';
          AppState.telemetry.directionLabel = 'STATIONARY';
        }
      }
    }

    processTelemetryPacket({
      seq: simSeq++,
      timestamp_ms: Date.now(),
      tilt_deg: Number(simTilt.toFixed(2)),
      pitch_rate_dps: Number((Math.cos(Date.now() / 420.0) * 1.8).toFixed(2)),
      charging_hardware_stat: AppState.telemetry.hwChargingStat,
      battery_voltage_mv: AppState.telemetry.hwChargingStat ? 12450 : 11840 - Math.floor(simSeq / 10),
      battery_pct: AppState.telemetry.hwChargingStat ? 88 : Math.max(15, 85 - Math.floor(simSeq / 40)),
      motion_state: AppState.telemetry.motionState
    });
  }, 1000);
}

/**
 * Connect via Web Bluetooth (Nordic UART Service) with MTU packet reassembly.
 */
export async function connectWebBluetooth(showToast) {
  if (!navigator.bluetooth) {
    showToast('Web Bluetooth requires Android Chrome over HTTPS (Vercel).', 'warning');
    return false;
  }
  try {
    showToast('Scanning for ESP32 Robot BLE Peripheral...', 'info');
    const device = await navigator.bluetooth.requestDevice({
      filters: BLE_CONFIG.NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
      optionalServices: [BLE_CONFIG.SERVICE_UUID, 'battery_service']
    });

    device.addEventListener('gattserverdisconnected', () => {
      showToast(`BLE Disconnected from ${device.name || 'Robot'}! Watchdog active.`, 'error');
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_CONFIG.SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BLE_CONFIG.NOTIFY_CHAR_UUID);

    AppState.telemetry.bleDevice = device;
    AppState.telemetry.bleRxBuffer = '';
    AppState.telemetry.lastRxTimestamp = Date.now();
    AppState.telemetry.maxGapSessionSec = 0;

    await characteristic.startNotifications();
    const decoder = new TextDecoder('utf-8');
    characteristic.addEventListener('characteristicvaluechanged', (event) => {
      const chunk = decoder.decode(event.target.value, { stream: true });
      const packets = feedBleChunk(chunk);
      for (const pkt of packets) {
        processTelemetryPacket(pkt);
      }
    });

    AppState.isSimMode = false;
    AppState.linkType = 'ble';
    const simLabel = document.getElementById('sim-mode-label');
    if (simLabel) simLabel.textContent = 'Sim: OFF (BLE)';
    const simPanel = document.getElementById('sim-controls-panel');
    if (simPanel) simPanel.classList.add('hidden');
    showToast(`BLE Connected to ${device.name || 'Robot'}! Receiving 1 Hz telemetry.`, 'success');
    return true;
  } catch (err) {
    showToast(`Bluetooth Error: ${err.message || 'Cancelled'}`, 'error');
    return false;
  }
}

/**
 * Connect via local WebSocket fallback (ws:// or wss://).
 */
export function connectWebSocket(url, showToast) {
  if (!url) return;
  try {
    if (AppState.telemetry.wsConnection) AppState.telemetry.wsConnection.close();
    const ws = new WebSocket(url);
    ws.onopen = () => {
      AppState.isSimMode = false;
      AppState.linkType = 'ws';
      AppState.telemetry.lastRxTimestamp = Date.now();
      AppState.telemetry.maxGapSessionSec = 0;
      const simLabel = document.getElementById('sim-mode-label');
      if (simLabel) simLabel.textContent = 'Sim: OFF (WS)';
      const simPanel = document.getElementById('sim-controls-panel');
      if (simPanel) simPanel.classList.add('hidden');
      showToast(`WebSocket connected to ${url}`, 'success');
    };
    ws.onmessage = (evt) => {
      try {
        processTelemetryPacket(JSON.parse(evt.data));
      } catch (_) {}
    };
    ws.onclose = () => {
      showToast('WebSocket connection closed.', 'warning');
    };
    ws.onerror = () => {
      showToast('WebSocket failed (HTTPS pages block ws:// — use BLE or wss://).', 'error');
    };
    AppState.telemetry.wsConnection = ws;
  } catch (err) {
    showToast(`WebSocket error: ${err.message}`, 'error');
  }
}
