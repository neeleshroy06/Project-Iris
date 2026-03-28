const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  desktopCapturer,
  screen,
  Menu,
} = require('electron');
const path = require('path');
const { execFile } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const shellPreload = path.join(__dirname, 'preload-shell.js');
/** Window / taskbar branding (replaces default Electron icon when set on BrowserWindow). */
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'iris-logo.png');
const {
  extractChartJson,
  buildXlsxBuffer,
  extractTextFileJson,
  buildTxtBuffer,
} = require('./xlsx-from-chart');
const { extractMapsLinkJson } = require('./maps-from-screen');

const memoryStore = require('./memory-store');
const googleCalendar = require('./google-calendar');

let mainWindow = null;
let focusBarWindow = null;
let overlayWindow = null;

/** Last requested focus-bar window size (content drives this via `focus-bar:resize`). */
let focusBarContentSize = { width: 580, height: 54 };

/** Mirrors interactive rows (links, downloads) for the focus bar; replayed when the bar is shown. */
const FOCUS_BAR_DOCK_MAX = 14;
let focusBarDockItems = [];
let sessionLive = false;
let overlayDrawingMode = false;

/** Synced with renderer (localStorage); used for focus bar + cross-window UI. */
let observationMode = 'silent';

/** After “Done” on focus regions, ignore auto-hide until this time (ms) — avoids spurious restore/focus. */
let focusBarAutoHideSuppressedUntil = 0;

function broadcastObservationMode() {
  const payload = { mode: observationMode };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('iris:observation-mode', payload);
  }
  if (focusBarWindow && !focusBarWindow.isDestroyed()) {
    focusBarWindow.webContents.send('iris:observation-mode', payload);
  }
}

/** @type {{ videoWidth?: number, videoHeight?: number, encodeWidth?: number, encodeHeight?: number, displaySurface?: string|null, electronSourceId?: string|null, sourceName?: string|null } | null} */
let captureMetrics = null;

function sizeNear(a, b, tol = 6) {
  return Math.abs(a - b) <= tol;
}

function findDisplayForVideoSize(vw, vh) {
  if (!vw || !vh) return null;
  const displays = screen.getAllDisplays();
  const candidates = [];
  for (const d of displays) {
    const b = d.bounds;
    if (sizeNear(vw, b.width) && sizeNear(vh, b.height)) candidates.push(d);
    const sw = Math.round(b.width * d.scaleFactor);
    const sh = Math.round(b.height * d.scaleFactor);
    if (sizeNear(vw, sw) && sizeNear(vh, sh)) candidates.push(d);
    if (d.size && sizeNear(vw, d.size.width) && sizeNear(vh, d.size.height)) {
      candidates.push(d);
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const d of candidates) {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      uniq.push(d);
    }
  }
  if (uniq.length === 1) return uniq[0];
  if (uniq.length > 1) {
    const near = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const pick = uniq.find((d) => d.id === near.id);
    return pick || uniq[0];
  }
  return null;
}

/**
 * Overlay rects are in overlay canvas pixels; map to absolute virtual-desktop coords.
 */
function overlayRectsToAbsolute(rects, canvasW, canvasH) {
  const vb = getVirtualBounds();
  const cw = canvasW || vb.width;
  const ch = canvasH || vb.height;
  const sx = vb.width / Math.max(1, cw);
  const sy = vb.height / Math.max(1, ch);
  return rects.map((r) => ({
    x: vb.x + r.x * sx,
    y: vb.y + r.y * sy,
    w: r.w * sx,
    h: r.h * sy,
  }));
}

function mapAbsRectToDisplayNorm(abs, d) {
  const bx = d.bounds.x;
  const by = d.bounds.y;
  const bw = d.bounds.width;
  const bh = d.bounds.height;
  const ix1 = Math.max(abs.x, bx);
  const iy1 = Math.max(abs.y, by);
  const ix2 = Math.min(abs.x + abs.w, bx + bw);
  const iy2 = Math.min(abs.y + abs.h, by + bh);
  const iw = ix2 - ix1;
  const ih = iy2 - iy1;
  if (iw < 4 || ih < 4) return null;
  return {
    nx: (ix1 - bx) / bw,
    ny: (iy1 - by) / bh,
    nw: iw / bw,
    nh: ih / bh,
  };
}

/** DIP rectangle on the virtual desktop that matches normalized coords vs this display (same box as norm_0_1). */
function vdRectFromDisplayNorm(n, d) {
  const b = d.bounds;
  return {
    x: b.x + n.nx * b.width,
    y: b.y + n.ny * b.height,
    w: n.nw * b.width,
    h: n.nh * b.height,
  };
}

/**
 * Prefer matching a `screen:` source to `Display` via desktopCapturer (reliable on multi-monitor).
 */
async function findDisplayForCapture(vw, vh, electronSourceId) {
  if (electronSourceId && String(electronSourceId).startsWith('screen:')) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const src = sources.find((s) => s.id === electronSourceId);
      const did = src?.display_id;
      if (did != null && String(did) !== '') {
        const displays = screen.getAllDisplays();
        const match = displays.find((d) => String(d.id) === String(did));
        if (match) return match;
      }
    } catch {
      /* ignore */
    }
  }
  if (vw && vh) return findDisplayForVideoSize(vw, vh);
  return null;
}

async function describeElectronCaptureSource(electronSourceId) {
  if (!electronSourceId) return null;
  const id = String(electronSourceId);
  const types = id.startsWith('window:') ? ['window'] : id.startsWith('screen:') ? ['screen'] : ['screen', 'window'];
  try {
    const sources = await desktopCapturer.getSources({ types });
    const s = sources.find((x) => x.id === electronSourceId);
    const name = s?.name?.trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Human-readable stream / coordinate context so the model can align regions with the actual JPEGs.
 */
function buildStreamGeometryLines(metrics, display, canvasW, canvasH, vb) {
  const vw = metrics?.videoWidth;
  const vh = metrics?.videoHeight;
  const ew = metrics?.encodeWidth;
  const eh = metrics?.encodeHeight;

  const lines = [
    '=== Screen capture dimensions (this session) ===',
    'How to read region lines below:',
    '- norm_0_1: x,y,w,h each in [0,1], origin top-left of the shared video frame (same box on native stream and on each JPEG).',
    '- native_stream_px / jpeg_px: integer pixel rectangle (left, top, width, height) on that frame size.',
    '- virtual_desktop_DIP: same region in OS logical coordinates across all monitors (from the drawing overlay).',
  ];

  if (vw && vh) {
    lines.push(`NATIVE_STREAM_PX: width=${vw} height=${vh}`);
  }
  if (ew && eh) {
    lines.push(`JPEG_SENT_PX: width=${ew} height=${eh} (uniform downscale of the stream; aspect ratio unchanged)`);
  }
  if (vw && vh && ew && eh) {
    const rStream = (vw / vh).toFixed(4);
    const rJpeg = (ew / eh).toFixed(4);
    lines.push(`ASPECT_CHECK: native_w/h=${rStream} jpeg_w/h=${rJpeg} (should match)`);
  }

  const surf = metrics?.displaySurface;
  if (surf) {
    lines.push(`displaySurface: ${surf}`);
  }
  if (metrics?.sourceName) {
    lines.push(`shared_item_name: "${metrics.sourceName}"`);
  }
  if (metrics?.electronSourceId) {
    lines.push(`capture_source_id: ${metrics.electronSourceId}`);
  }
  if (display) {
    const b = display.bounds;
    lines.push(
      `matched_monitor_DIP: left=${b.x} top=${b.y} width=${b.width} height=${b.height} (when capture is this full display, norm is relative to this rectangle)`
    );
  }
  lines.push(
    `virtual_desktop_total_DIP: left=${vb.x} top=${vb.y} width=${vb.width} height=${vb.height}`
  );
  if (canvasW && canvasH) {
    lines.push(
      `focus_overlay_canvas_px: width=${canvasW} height=${canvasH} (maps to virtual_desktop_total_DIP)`
    );
  }
  lines.push('=== End screen capture dimensions ===');
  return lines;
}

/**
 * @param {object} n normalized rect vs shared frame
 * @param {{ x: number, y: number, w: number, h: number } | null} absRect virtual-desktop absolute rect (DIP), if known
 */
function formatRegionLine(label, n, ew, eh, vw, vh, absRect) {
  const parts = [
    `Region ${label}`,
    `norm_0_1 x=${n.nx.toFixed(4)} y=${n.ny.toFixed(4)} w=${n.nw.toFixed(4)} h=${n.nh.toFixed(4)}`,
  ];
  if (vw && vh) {
    parts.push(
      `native_stream_px left=${Math.round(n.nx * vw)} top=${Math.round(n.ny * vh)} w=${Math.round(n.nw * vw)} h=${Math.round(n.nh * vh)}`
    );
  }
  if (ew && eh) {
    parts.push(
      `jpeg_px left=${Math.round(n.nx * ew)} top=${Math.round(n.ny * eh)} w=${Math.round(n.nw * ew)} h=${Math.round(n.nh * eh)}`
    );
  }
  if (absRect) {
    parts.push(
      `virtual_desktop_DIP left=${Math.round(absRect.x)} top=${Math.round(absRect.y)} w=${Math.round(absRect.w)} h=${Math.round(absRect.h)}`
    );
  }
  return parts.join(' | ');
}

/**
 * @returns {{ text: string, regions: Array<{ nx: number, ny: number, nw: number, nh: number }>, composite: boolean }}
 */
function computeFocusMapping(rects, canvasW, canvasH, metrics, display) {
  const vb = getVirtualBounds();
  if (!rects || !rects.length) {
    return {
      text:
        '[Iris focus grounding] The user finished with no focus regions drawn. Ignore prior region numbers until they add new ones.',
      regions: [],
      composite: false,
    };
  }

  const absRects = overlayRectsToAbsolute(rects, canvasW, canvasH);
  const vw = metrics?.videoWidth;
  const vh = metrics?.videoHeight;
  const ew = metrics?.encodeWidth;
  const eh = metrics?.encodeHeight;
  const displaySurface = metrics?.displaySurface || null;

  const lines = [
    '[Iris focus grounding] Numbered focus regions for the current screen share. Use the dimension block and each region line (norm_0_1, native_stream_px, jpeg_px, virtual_desktop_DIP) with each still image (~1 fps).',
    ...buildStreamGeometryLines(metrics, display, canvasW, canvasH, vb),
  ];

  const treatAsWindow =
    displaySurface === 'window' ||
    (metrics?.electronSourceId &&
      String(metrics.electronSourceId).startsWith('window:'));

  if (!treatAsWindow && display && vw && vh) {
    const mapped = [];
    /** @type {Array<{ nx: number, ny: number, nw: number, nh: number, label: number }>} */
    const encodeRegions = [];
    absRects.forEach((abs, idx) => {
      const n = mapAbsRectToDisplayNorm(abs, display);
      if (n) {
        const label = idx + 1;
        mapped.push(formatRegionLine(label, n, ew, eh, vw, vh, vdRectFromDisplayNorm(n, display)));
        encodeRegions.push({ nx: n.nx, ny: n.ny, nw: n.nw, nh: n.nh, label });
      }
    });
    if (mapped.length) {
      lines.push(
        'Aligned to the shared monitor capture (same pixel grid as your images after any uniform scaling).',
        ...mapped,
        'When the user says "region N", answer about the content inside that rectangle on the current frame.'
      );
      if (encodeRegions.length < absRects.length) {
        lines.push(
          `Note: ${absRects.length - encodeRegions.length} region(s) were too small or off-screen on the captured display and were omitted from the list above.`
        );
      }
      return {
        text: lines.join('\n'),
        regions: encodeRegions,
        composite: encodeRegions.length > 0,
      };
    }
  }

  const fallback = absRects.map((abs, idx) => {
    const n = {
      nx: (abs.x - vb.x) / vb.width,
      ny: (abs.y - vb.y) / vb.height,
      nw: abs.w / vb.width,
      nh: abs.h / vb.height,
    };
    return formatRegionLine(idx + 1, n, ew, eh, vw, vh, abs);
  });
  lines.push(
    'Full virtual-desktop layout (all monitors). If the user shares only one app window, these may NOT align with the cropped image—tell them to share the entire display for exact alignment.',
    ...fallback
  );
  return {
    text: lines.join('\n'),
    regions: [],
    composite: false,
  };
}

async function pullLatestCaptureMetricsFromRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const meta = await mainWindow.webContents.executeJavaScript(
      'window.__irisCaptureMeta || null'
    );
    if (meta && typeof meta === 'object') {
      return {
        videoWidth: meta.videoWidth || 0,
        videoHeight: meta.videoHeight || 0,
        encodeWidth: meta.encodeWidth || 0,
        encodeHeight: meta.encodeHeight || 0,
        displaySurface: meta.displaySurface || null,
        electronSourceId: meta.electronSourceId || null,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function getVirtualBounds() {
  const displays = screen.getAllDisplays();
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const d of displays) {
    const b = d.bounds;
    xMin = Math.min(xMin, b.x);
    yMin = Math.min(yMin, b.y);
    xMax = Math.max(xMax, b.x + b.width);
    yMax = Math.max(yMax, b.y + b.height);
  }
  return { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
}

function positionFocusBar() {
  if (!focusBarWindow || focusBarWindow.isDestroyed()) return;
  const primary = screen.getPrimaryDisplay();
  const b = primary.workArea;
  const barW = focusBarContentSize.width;
  const barH = focusBarContentSize.height;
  focusBarWindow.setBounds({
    x: Math.round(b.x + b.width - barW - 12),
    y: Math.round(b.y + 12),
    width: barW,
    height: barH,
  });
}

function clearFocusBarDockState() {
  focusBarDockItems = [];
  if (focusBarWindow && !focusBarWindow.isDestroyed()) {
    try {
      focusBarWindow.webContents.send('iris:focus-bar-dock-clear');
    } catch {
      /* ignore */
    }
  }
}

function pushFocusBarDockItem(item) {
  if (!item || typeof item !== 'object') return;
  const id =
    typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : `dock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const next = { ...item, id };
  focusBarDockItems.push(next);
  if (focusBarDockItems.length > FOCUS_BAR_DOCK_MAX) {
    focusBarDockItems = focusBarDockItems.slice(-FOCUS_BAR_DOCK_MAX);
  }
  if (focusBarWindow && !focusBarWindow.isDestroyed()) {
    try {
      focusBarWindow.webContents.send('iris:focus-bar-dock-push', next);
    } catch {
      /* ignore */
    }
  }
}

function syncFocusBarDockToWindow() {
  if (!focusBarWindow || focusBarWindow.isDestroyed()) return;
  const wc = focusBarWindow.webContents;
  const send = () => {
    try {
      wc.send('iris:focus-bar-dock-sync', focusBarDockItems);
    } catch {
      /* ignore */
    }
  };
  if (wc.isLoading()) wc.once('did-finish-load', send);
  else send();
}

function ensureFocusBarWindow() {
  if (focusBarWindow && !focusBarWindow.isDestroyed()) return focusBarWindow;
  focusBarWindow = new BrowserWindow({
    width: focusBarContentSize.width,
    height: focusBarContentSize.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: shellPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    focusBarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* ignore */
  }
  /* Above overlay (same always-on-top stack): higher relative layer = closer to user. */
  try {
    focusBarWindow.setAlwaysOnTop(true, 'screen-saver', 2);
  } catch {
    try {
      focusBarWindow.setAlwaysOnTop(true, 'pop-up-menu');
    } catch {
      focusBarWindow.setAlwaysOnTop(true);
    }
  }
  focusBarWindow.loadFile(path.join(__dirname, 'renderer', 'focus-bar.html'));
  focusBarWindow.on('closed', () => {
    focusBarWindow = null;
  });
  return focusBarWindow;
}

function whenOverlayReady(win, fn) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', fn);
  else fn();
}

function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const vb = getVirtualBounds();
  overlayWindow = new BrowserWindow({
    x: Math.round(vb.x),
    y: Math.round(vb.y),
    width: Math.round(vb.width),
    height: Math.round(vb.height),
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    focusable: false,
    webPreferences: {
      preload: shellPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  try {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* ignore */
  }
  /* Plain alwaysOnTop only: elevated levels (e.g. screen-saver) can skew getContentBounds vs
   * getVirtualBounds on Windows and break overlay → virtual-desktop coordinate mapping. */
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay-focus.html'));
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayDrawingMode = false;
  });
  return overlayWindow;
}

function resizeOverlayToVirtualScreen() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const vb = getVirtualBounds();
  const rw = Math.round(vb.width);
  const rh = Math.round(vb.height);
  overlayWindow.setBounds({
    x: Math.round(vb.x),
    y: Math.round(vb.y),
    width: rw,
    height: rh,
  });
  const sendContentSize = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    /* Same numbers as getVirtualBounds() used in overlayRectsToAbsolute — avoids drift from
     * getContentBounds() on Windows when the overlay must match the full virtual desktop. */
    overlayWindow.webContents.send('overlay:reposition', {
      width: rw,
      height: rh,
    });
  };
  sendContentSize();
  /* One tick later: bounds are sometimes applied asynchronously on Windows. */
  setImmediate(sendContentSize);
}

function showFocusBar() {
  if (!sessionLive) return;
  const win = ensureFocusBarWindow();
  positionFocusBar();
  win.show();
  raiseFocusBarAboveOverlay();
  try {
    win.webContents.send('iris:observation-mode', { mode: observationMode });
  } catch {
    /* ignore */
  }
  syncFocusBarDockToWindow();
}

function hideFocusBar() {
  if (focusBarWindow && !focusBarWindow.isDestroyed()) {
    focusBarWindow.hide();
  }
}

/** Hide focus bar when the user brings the main Iris window forward — not during Done/overlay churn. */
function hideFocusBarForMainWindowActivation() {
  if (Date.now() < focusBarAutoHideSuppressedUntil) return;
  hideFocusBar();
}

/** Keep the compact bar above the full-screen overlay (focus bar uses a higher always-on-top level). */
function raiseFocusBarAboveOverlay() {
  if (!sessionLive) return;
  if (!focusBarWindow || focusBarWindow.isDestroyed()) return;
  try {
    focusBarWindow.setAlwaysOnTop(true, 'screen-saver', 2);
  } catch {
    try {
      focusBarWindow.setAlwaysOnTop(true, 'pop-up-menu');
    } catch {
      focusBarWindow.setAlwaysOnTop(true);
    }
  }
  try {
    focusBarWindow.moveTop();
  } catch {
    /* ignore */
  }
}

function showOverlayDrawing() {
  const win = ensureOverlayWindow();
  whenOverlayReady(win, () => {
    resizeOverlayToVirtualScreen();
    overlayDrawingMode = true;
    win.setFocusable(true);
    win.show();
    win.setIgnoreMouseEvents(false);
    // Hidden overlay often reports innerWidth/innerHeight as 0; re-send bounds after show.
    resizeOverlayToVirtualScreen();
    win.webContents.send('overlay:set-drawing', { drawing: true });
    setImmediate(() => {
      raiseFocusBarAboveOverlay();
      setTimeout(() => raiseFocusBarAboveOverlay(), 80);
    });
  });
}

function showOverlayPassthrough() {
  overlayDrawingMode = false;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  whenOverlayReady(overlayWindow, () => {
    overlayWindow.webContents.send('overlay:set-drawing', { drawing: false });
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.setFocusable(false);
    overlayWindow.webContents.send('overlay:request-grounding');
    setImmediate(() => {
      raiseFocusBarAboveOverlay();
      setTimeout(() => raiseFocusBarAboveOverlay(), 80);
    });
  });
}

function hideOverlayFully() {
  overlayDrawingMode = false;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  whenOverlayReady(overlayWindow, () => {
    overlayWindow.webContents.send('overlay:clear');
    overlayWindow.hide();
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    if (sessionLive) raiseFocusBarAboveOverlay();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 820,
    minWidth: 720,
    minHeight: 640,
    title: 'Iris — Gemini Live',
    icon: APP_ICON,
    backgroundColor: '#0f1e38',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  /* Focus bar: show while Iris is minimized during a live session; hide when the user restores/focuses Iris.
   * `restore`/`focus` can still fire briefly after “Done” on focus regions (overlay + IPC); those are
   * suppressed for a few seconds via focusBarAutoHideSuppressedUntil. Only Stop share ends capture. */
  win.on('minimize', () => {
    if (sessionLive) showFocusBar();
  });

  win.on('restore', () => {
    if (sessionLive) hideFocusBarForMainWindowActivation();
  });

  win.on('focus', () => {
    if (!sessionLive || win.isMinimized()) return;
    hideFocusBarForMainWindowActivation();
  });

  win.on('close', () => {
    sessionLive = false;
    focusBarContentSize = { width: 580, height: 54 };
    focusBarDockItems = [];
    if (focusBarWindow && !focusBarWindow.isDestroyed()) {
      focusBarWindow.destroy();
      focusBarWindow = null;
    }
  });

  win.on('closed', () => {
    mainWindow = null;
    sessionLive = false;
    hideFocusBar();
    hideOverlayFully();
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(APP_ICON);
    } catch {
      /* ignore */
    }
  }

  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowMedia =
        permission === 'media' ||
        permission === 'display-capture' ||
        permission === 'speaker-selection';
      callback(!!allowMedia);
    }
  );

  createWindow();

  screen.on('display-metrics-changed', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      whenOverlayReady(overlayWindow, () => resizeOverlayToVirtualScreen());
    }
    if (sessionLive) {
      positionFocusBar();
      raiseFocusBarAboveOverlay();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/** Electron window id is `window:XX:YY` — XX is the native window handle on Windows. */
function hwndFromElectronWindowId(id) {
  if (!id || typeof id !== 'string' || !id.startsWith('window:')) return null;
  const parts = id.split(':');
  if (parts.length < 2) return null;
  const n = parseInt(parts[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function focusWindowsWindow(hwnd) {
  const h = Number(hwnd);
  if (!Number.isFinite(h) || h <= 0) return;
  /** Only SetForegroundWindow — no ShowWindow/SW_RESTORE (avoids changing size or restore state). */
  const ps = `
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class IrisW32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
} catch {}
[void][IrisW32]::SetForegroundWindow([IntPtr]${h})
`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true,
    timeout: 8000,
  });
}

async function hwndFromWindowTitleHint(title) {
  if (!title || typeof title !== 'string') return null;
  const t = title.trim();
  if (!t) return null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1, height: 1 },
    });
    const norm = (s) => s.trim().toLowerCase();
    const wanted = norm(t);
    let match = sources.find((s) => norm(s.name) === wanted);
    if (!match) {
      match = sources.find(
        (s) => norm(s.name).includes(wanted) || wanted.includes(norm(s.name))
      );
    }
    if (!match) return null;
    return hwndFromElectronWindowId(match.id);
  } catch {
    return null;
  }
}

ipcMain.on('iris:minimize-compact', async (_e, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { electronSourceId, windowTitleHint } = payload || {};
  const finish = () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    }, 120);
  };
  if (process.platform !== 'win32') {
    finish();
    return;
  }
  try {
    let hwnd = hwndFromElectronWindowId(electronSourceId);
    if (hwnd == null && windowTitleHint) {
      hwnd = await hwndFromWindowTitleHint(windowTitleHint);
    }
    if (hwnd != null) {
      focusWindowsWindow(hwnd);
    }
  } catch {
    /* ignore */
  }
  finish();
});

ipcMain.on('focus-bar:stop-share', () => {
  if (!sessionLive) return;
  hideOverlayFully();
  hideFocusBar();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('iris:stop-screen-share');
  }
});

function ipcSetObservationMode(_e, mode) {
  if (mode !== 'ambient' && mode !== 'silent') return;
  observationMode = mode;
  broadcastObservationMode();
}

ipcMain.on('iris:set-observation-mode', ipcSetObservationMode);
ipcMain.on('focus-bar:set-observation-mode', ipcSetObservationMode);

ipcMain.handle('iris:get-observation-mode', () => ({ mode: observationMode }));

async function ipcExportScreenFile(_e, payload) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in .env');
  }
  const imageBase64 = typeof payload?.imageBase64 === 'string' ? payload.imageBase64.trim() : '';
  if (!imageBase64) {
    throw new Error('No screen image — share your screen first.');
  }
  const hint = typeof payload?.title === 'string' ? payload.title.trim() : '';
  const fmt = payload?.format === 'txt' ? 'txt' : 'xlsx';

  if (fmt === 'txt') {
    const { title, text } = await extractTextFileJson(apiKey, imageBase64, hint);
    const buf = buildTxtBuffer(text);
    const base64 = buf.toString('base64');
    const stem = String(title)
      .replace(/[^\w\-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    const filename = `${stem || 'screen-text'}.txt`;
    return { filename, base64, format: 'txt', byteLength: buf.length };
  }

  const { title, rows } = await extractChartJson(apiKey, imageBase64, hint);
  if (!rows.length) {
    throw new Error('No chart or table data could be read from the image.');
  }
  const buf = buildXlsxBuffer(rows, title);
  const base64 = buf.toString('base64');
  const stem = String(title)
    .replace(/[^\w\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  const filename = `${stem || 'chart-data'}.xlsx`;
  return { filename, base64, format: 'xlsx', rowCount: rows.length };
}

ipcMain.handle('iris:export-screen-file', ipcExportScreenFile);
ipcMain.handle('iris:build-xlsx-from-screen', async (e, payload) =>
  ipcExportScreenFile(e, { ...payload, format: 'xlsx' })
);

ipcMain.handle('iris:maps-link-from-screen', async (_e, payload) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in .env');
  }
  const imageBase64 = typeof payload?.imageBase64 === 'string' ? payload.imageBase64.trim() : '';
  if (!imageBase64) {
    throw new Error('No screen image — share your screen first.');
  }
  const userHint = typeof payload?.userHint === 'string' ? payload.userHint.trim() : '';
  return extractMapsLinkJson(apiKey, imageBase64, userHint);
});

ipcMain.on('iris:set-session-live', (_e, live) => {
  sessionLive = !!live;
  if (!sessionLive) {
    captureMetrics = null;
    focusBarContentSize = { width: 580, height: 54 };
    clearFocusBarDockState();
    hideFocusBar();
    hideOverlayFully();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('iris:set-capture-focus-regions', {
        regions: [],
        composite: false,
      });
    }
  } else if (mainWindow && mainWindow.isMinimized()) {
    showFocusBar();
  }
});

ipcMain.on('iris:push-focus-bar-dock', (_e, item) => {
  pushFocusBarDockItem(item);
});

ipcMain.on('focus-bar:resize', (_e, payload) => {
  const w = Math.round(Number(payload?.width));
  const h = Math.round(Number(payload?.height));
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  focusBarContentSize.width = Math.min(640, Math.max(320, w));
  focusBarContentSize.height = Math.min(720, Math.max(54, h));
  if (focusBarWindow && !focusBarWindow.isDestroyed()) {
    positionFocusBar();
  }
});

ipcMain.on('focus-bar:composer-submit', (_e, text) => {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('iris:focus-bar-composer-submit', t);
});

ipcMain.handle('iris:focus-bar-dock-snapshot', () => ({ items: focusBarDockItems }));

ipcMain.handle('iris:open-external', async (_e, url) => {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    await shell.openExternal(s);
    return true;
  } catch {
    return false;
  }
});

ipcMain.on('focus-bar:dock-dismiss', (_e, id) => {
  const sid = typeof id === 'string' ? id.trim() : '';
  if (!sid) return;
  focusBarDockItems = focusBarDockItems.filter((x) => x.id !== sid);
});

ipcMain.on('iris:capture-metrics', (_e, metrics) => {
  if (!metrics || typeof metrics !== 'object') {
    captureMetrics = null;
    return;
  }
  captureMetrics = {
    videoWidth: metrics.videoWidth || 0,
    videoHeight: metrics.videoHeight || 0,
    encodeWidth: metrics.encodeWidth || 0,
    encodeHeight: metrics.encodeHeight || 0,
    displaySurface: metrics.displaySurface || null,
    electronSourceId: metrics.electronSourceId || null,
  };
});

ipcMain.handle('iris:focus-rects-update', async (_e, payload) => {
  const fresh = await pullLatestCaptureMetricsFromRenderer();
  if (fresh) {
    captureMetrics = { ...captureMetrics, ...fresh };
  }
  const rects = payload?.rects || [];
  const cw = payload?.canvasWidth;
  const ch = payload?.canvasHeight;
  let m = captureMetrics;
  const sourceName = await describeElectronCaptureSource(m?.electronSourceId);
  if (sourceName) m = { ...m, sourceName };
  const display = await findDisplayForCapture(
    m?.videoWidth,
    m?.videoHeight,
    m?.electronSourceId
  );
  const result = computeFocusMapping(rects, cw, ch, m, display);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('iris:apply-focus-grounding', result.text);
    mainWindow.webContents.send('iris:set-capture-focus-regions', {
      regions: result.regions,
      composite: result.composite,
    });
  }
  return true;
});

ipcMain.on('overlay:set-mouse-through', (_e, payload) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const passThrough = payload?.passThrough !== false;
  if (passThrough) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlayWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.on('focus-bar:add-regions', () => {
  if (!sessionLive) return;
  showOverlayDrawing();
});

ipcMain.on('focus-bar:done-drawing', () => {
  if (!sessionLive) return;
  /* Block auto-hide briefly: restore/focus on the main window often fire spuriously right after
   * overlay passthrough + focus-grounding IPC (~100–600ms). Keep this window short so a real
   * taskbar restore still hides the bar soon after. */
  focusBarAutoHideSuppressedUntil = Date.now() + 750;
  showOverlayPassthrough();
});

ipcMain.handle('iris:get-api-key', () => {
  const key = process.env.GEMINI_API_KEY || '';
  return key.trim();
});

ipcMain.handle('iris:get-memory-profile', () => ({
  profileText: memoryStore.getProfileText(),
}));

ipcMain.handle('iris:memory-append-turn', async (_, payload) => {
  memoryStore.appendTurn(payload);
  memoryStore.scheduleAutoConsolidate(process.env.GEMINI_API_KEY || '');
});

ipcMain.handle('iris:memory-session-ended', async () => {
  memoryStore.cancelAutoConsolidateTimer();
  const key = process.env.GEMINI_API_KEY || '';
  if (!key.trim()) return false;
  try {
    await memoryStore.consolidate(key);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('iris:google-calendar-status', () => googleCalendar.getCalendarStatus());

ipcMain.handle('iris:google-calendar-auth', async () => {
  await googleCalendar.startAuthFlow();
  return googleCalendar.getCalendarStatus();
});

ipcMain.handle('iris:google-calendar-create-event', async (_e, payload) =>
  googleCalendar.createCalendarEvent(payload && typeof payload === 'object' ? payload : {})
);

ipcMain.handle('iris:get-app-version', () => require('./package.json').version);

ipcMain.handle('iris:get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnailDataUrl: s.thumbnail.toDataURL(),
  }));
});
