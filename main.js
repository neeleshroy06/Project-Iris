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

let mainWindow = null;
let focusBarWindow = null;
let overlayWindow = null;
let sessionLive = false;
let overlayDrawingMode = false;

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
  const barW = 440;
  const barH = 54;
  focusBarWindow.setBounds({
    x: Math.round(b.x + b.width - barW - 12),
    y: Math.round(b.y + 12),
    width: barW,
    height: barH,
  });
}

function ensureFocusBarWindow() {
  if (focusBarWindow && !focusBarWindow.isDestroyed()) return focusBarWindow;
  focusBarWindow = new BrowserWindow({
    width: 440,
    height: 54,
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
    const cb = overlayWindow.getContentBounds();
    const w = cb.width > 0 ? cb.width : rw;
    const h = cb.height > 0 ? cb.height : rh;
    overlayWindow.webContents.send('overlay:reposition', {
      width: w,
      height: h,
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
  try {
    win.moveTop();
  } catch {
    /* ignore */
  }
}

function hideFocusBar() {
  if (focusBarWindow && !focusBarWindow.isDestroyed()) {
    focusBarWindow.hide();
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
    if (focusBarWindow && !focusBarWindow.isDestroyed()) {
      try {
        focusBarWindow.moveTop();
      } catch {
        /* ignore */
      }
    }
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
    if (focusBarWindow && !focusBarWindow.isDestroyed()) {
      try {
        focusBarWindow.moveTop();
      } catch {
        /* ignore */
      }
    }
  });
}

function hideOverlayFully() {
  overlayDrawingMode = false;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  whenOverlayReady(overlayWindow, () => {
    overlayWindow.webContents.send('overlay:clear');
    overlayWindow.hide();
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 820,
    minWidth: 720,
    minHeight: 640,
    title: 'Iris — Gemini Live',
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

  win.on('minimize', () => {
    if (sessionLive) showFocusBar();
  });

  win.on('restore', () => {
    hideFocusBar();
  });

  win.on('show', () => {
    if (!win.isMinimized()) hideFocusBar();
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
    positionFocusBar();
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

ipcMain.on('iris:set-session-live', (_e, live) => {
  sessionLive = !!live;
  if (!sessionLive) {
    captureMetrics = null;
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

ipcMain.on('focus-bar:add-regions', () => {
  if (!sessionLive) return;
  showOverlayDrawing();
});

ipcMain.on('focus-bar:done-drawing', () => {
  if (!sessionLive) return;
  showOverlayPassthrough();
});

ipcMain.handle('iris:get-api-key', () => {
  const key = process.env.GEMINI_API_KEY || '';
  return key.trim();
});

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
