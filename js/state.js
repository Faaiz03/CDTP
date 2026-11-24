/**
 * Centralized application state, YTU EEF Module D specification constants,
 * and localStorage persistence.
 */

export const BLE_CONFIG = {
  SERVICE_UUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  NOTIFY_CHAR_UUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  NAME_PREFIXES: ['BalancingRobot', 'YTU_Robot', 'ESP32']
};

export const ARUCO_IDS = {
  ROBOT: 0,
  BOX: 1,
  DOCK: 2,
  CORNER_TL: 10,
  CORNER_TR: 11,
  CORNER_BR: 12,
  CORNER_BL: 13
};

export const SPEC_LIMITS = {
  WATCHDOG_MAX_GAP_SEC: 2.0,
  MAX_TILT_DEG: 10.0,
  STATIC_BALANCE_TARGET_SEC: 30.0,
  DURATION_TOLERANCE_SEC: 2.0,
  GUIDANCE_MIN_DIST_M: 0.8,
  GUIDANCE_MAX_DIST_M: 1.2,
  DOCK_RADIUS_M: 0.3,
  CHARGE_START_MAX_SEC: 5.0,
  CHARGE_DISCONNECT_MAX_SEC: 2.0,
  INTEGRATED_INIT_BALANCE_SEC: 5.0,
  BOX_SEP_FAIL_M: 0.28,
  BOX_MISSING_FAIL_MS: 2500
};

export const TASK_DEFS = {
  A: {
    id: 'A',
    badge: 'Module A (Static Balance)',
    title: 'Active 30 s Upright Balance',
    metric: 'Remain balanced upright (|tilt| <= 10 deg) for 30 s (+/-2 s) with medication box secure.',
    subtestPts: 5,
    modulePts: 20
  },
  B: {
    id: 'B',
    badge: 'Module B (Guidance)',
    title: 'Wearable Direction & Distance (0.8-1.2 m)',
    metric: 'Follow wearable commands across 0.8-1.2 m with verified direction changes and zero box drop.',
    subtestPts: 5,
    modulePts: 20
  },
  C: {
    id: 'C',
    badge: 'Module C (Auto Charging)',
    title: 'Autonomous Docking & <= 5 s Charge Start',
    metric: 'Enter 30 cm dock zone autonomously and assert hardware CHG/STAT pin within 5.0 s.',
    subtestPts: 5,
    modulePts: 20
  },
  E: {
    id: 'E',
    badge: 'Module E (Integrated)',
    title: 'Full Scenario: Balance, Deliver (~1 m) & Dock',
    metric: 'Wait balanced (~5 s), move ~1 m with direction change, keep aspirin box secure, dock & charge <= 5 s.',
    subtestPts: 5,
    modulePts: 20
  }
};

export const AppState = {
  isSimMode: true,
  linkType: 'sim', // 'sim' | 'ble' | 'ws' | 'none'
  cameraActive: false,
  cameraFacingMode: 'environment',
  cameraStream: null,
  activeTab: 'tab-dashboard',
  currentTask: 'E',
  isTestRunning: false,
  testStartTime: null,
  testDurationMs: 0,
  timerInterval: null,

  // Tracking mode: 'aruco' | 'color'
  trackingMode: 'aruco',

  // Interactive canvas modes: 'none' | 'calib_floor' | 'pick_robot' | 'pick_box' | 'place_dock'
  interactiveMode: 'none',
  calibPointsPx: [], // 4 normalized [0..1] corners: TL, TR, BR, BL
  homographyMatrix: null,
  invHomographyMatrix: null,

  // Live Vision Tracker State (Dual: ArUco 4x4_50 + HSV Color)
  tracker: {
    hueTolerance: 22,
    minSat: 0.35,
    minVal: 0.25,
    robotHSV: { h: 215, s: 0.85, v: 0.85 },
    boxHSV: { h: 0, s: 0.85, v: 0.85 },
    robotDetected: false,
    boxDetected: false,
    dockTagDetected: false,
    robotPx: { x: 0.5, y: 0.5 },
    boxPx: { x: 0.5, y: 0.5 },
    boxMissingSince: null,
    smoothedPos: null,
    smoothedHeadingDeg: null,
    detectedMarkers: [], // Latest ArUco markers in normalized [0..1] coords
    lastFrameTime: 0
  },

  // Video Recording (MediaRecorder)
  recorder: {
    autoRecord: true,
    mediaRecorder: null,
    chunks: [],
    isRecording: false,
    lastVideoUrl: null
  },

  // 1 Hz Telemetry & Watchdog State
  telemetry: {
    lastRxTimestamp: Date.now(),
    seq: 0,
    tiltDeg: 0.8,
    pitchRateDps: 0.05,
    hwChargingStat: 0,
    prevHwChargingStat: 0,
    batteryMv: 11840,
    batteryPct: 82,
    motionState: 'STATIC_BALANCE',
    directionLabel: 'STATIONARY',
    liveGapSec: 0,
    maxGapSessionSec: 0,
    isLinkAlert: false,
    packetCount: 0,
    latencyMs: 12,
    wsConnection: null,
    bleDevice: null,
    bleRxBuffer: ''
  },

  // Active Test Run Metrics (tracked continuously for strict pass/fail)
  runMetrics: {
    maxAbsTiltDeg: 0,
    tiltViolation: false,
    tiltViolationDeg: 0,
    maxDisconnectGapSec: 0,
    linkDropCount: 0,
    directionsObserved: new Set(),
    motionStatesObserved: new Set(),
    initialHeadingDeg: null,
    headingDeltaAccumDeg: 0,
    lastHeadingDeg: null,
    dockZoneEnteredAt: null,
    chargingStartedAt: null,
    chargeStartDelaySec: null,
    chargingStableSince: null,
    dockExitAt: null,
    chargeOffDelaySec: null,
    initialBalanceHeldSec: 0,
    firstMotionAt: null
  },

  // Vision World Plane (meters)
  vision: {
    robotPos: { x: 0.35, y: 1.1 },
    robotHeadingDeg: 0.0,
    velocityMps: 0.0,
    angularVelDps: 0.0,
    distanceTraveledM: 0.0,
    lastPos: { x: 0.35, y: 1.1 },
    cargoSecure: true,
    cargoDropReason: '',
    dockPos: { x: 1.25, y: 0.35 },
    dockApproachAngleDeg: 135, // Direction dock faces into the arena
    inDockZone: false,
    isDocked: false,
    trajectory: []
  },

  // Arena Physical Dimensions
  arena: {
    widthM: 1.5,
    depthM: 1.5,
    dockRadiusM: 0.3
  },

  // Persisted test runs & rubric scorecard
  testHistory: [],
  rubricResults: {
    A: null,
    B: null,
    C: null,
    E: null
  }
};

export function resetRunMetrics() {
  AppState.runMetrics = {
    maxAbsTiltDeg: Math.abs(AppState.telemetry.tiltDeg),
    tiltViolation: false,
    tiltViolationDeg: 0,
    maxDisconnectGapSec: 0,
    linkDropCount: 0,
    directionsObserved: new Set(),
    motionStatesObserved: new Set(),
    initialHeadingDeg: AppState.vision.robotHeadingDeg,
    headingDeltaAccumDeg: 0,
    lastHeadingDeg: AppState.vision.robotHeadingDeg,
    dockZoneEnteredAt: null,
    chargingStartedAt: null,
    chargeStartDelaySec: null,
    chargingStableSince: null,
    dockExitAt: null,
    chargeOffDelaySec: null,
    initialBalanceHeldSec: 0,
    firstMotionAt: null
  };
}

export function loadSavedState() {
  try {
    const savedHist = localStorage.getItem('ytu_robot_history_v2');
    if (savedHist) {
      const parsed = JSON.parse(savedHist);
      if (Array.isArray(parsed)) AppState.testHistory = parsed;
    }
    const savedArena = localStorage.getItem('ytu_robot_arena_v2');
    if (savedArena) {
      const a = JSON.parse(savedArena);
      if (a.widthM > 0) AppState.arena.widthM = a.widthM;
      if (a.depthM > 0) AppState.arena.depthM = a.depthM;
      if (a.dockRadiusM > 0) AppState.arena.dockRadiusM = a.dockRadiusM;
      if (a.trackingMode === 'aruco' || a.trackingMode === 'color') {
        AppState.trackingMode = a.trackingMode;
      }
      if (Array.isArray(a.calibPointsPx) && a.calibPointsPx.length === 4) {
        AppState.calibPointsPx = a.calibPointsPx;
      }
      if (a.dockPos && typeof a.dockPos.x === 'number') {
        AppState.vision.dockPos = a.dockPos;
      }
    }
    const savedRubric = localStorage.getItem('ytu_robot_rubric_v2');
    if (savedRubric) {
      const r = JSON.parse(savedRubric);
      if (r && typeof r === 'object') {
        AppState.rubricResults = { ...AppState.rubricResults, ...r };
      }
    }
  } catch (_) {
    // Ignore storage access errors in restricted contexts
  }
}

export function saveArenaState() {
  try {
    localStorage.setItem(
      'ytu_robot_arena_v2',
      JSON.stringify({
        widthM: AppState.arena.widthM,
        depthM: AppState.arena.depthM,
        dockRadiusM: AppState.arena.dockRadiusM,
        trackingMode: AppState.trackingMode,
        calibPointsPx: AppState.calibPointsPx,
        dockPos: AppState.vision.dockPos
      })
    );
  } catch (_) {}
}

export function saveHistoryState() {
  try {
    const serializable = AppState.testHistory.map(({ videoUrl, ...rest }) => rest);
    localStorage.setItem('ytu_robot_history_v2', JSON.stringify(serializable.slice(0, 40)));
    localStorage.setItem('ytu_robot_rubric_v2', JSON.stringify(AppState.rubricResults));
  } catch (_) {}
}
