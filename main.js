const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  desktopCapturer,
  screen,
} = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const shellPreload = path.join(__dirname, 'preload-shell.js');

let mainWindow = null;
let focusBarWindow = null;
let overlayWindow = null;
let sessionLive = false;
let overlayDrawingMode = false;

/** @type {{ videoWidth?: number, videoHeight?: number, displaySurface?: string|null, electronSourceId?: string|null } | null} */
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
  if (iw < 6 || ih < 6) return null;
  return {
    nx: (ix1 - bx) / bw,
    ny: (iy1 - by) / bh,
    nw: iw / bw,
    nh: ih / bh,
  };
}

function buildFocusGroundingMessage(rects, canvasW, canvasH, metrics) {
  const vb = getVirtualBounds();
  if (!rects || !rects.length) {
    return '[Iris focus grounding] The user finished with no focus regions drawn. Ignore prior region numbers until they add new ones.';
  }

  const absRects = overlayRectsToAbsolute(rects, canvasW, canvasH);
  const vw = metrics?.videoWidth;
  const vh = metrics?.videoHeight;
  const displaySurface = metrics?.displaySurface || null;

  const lines = [
    '[Iris focus grounding] The user marked numbered focus regions. Use these boxes with each screen image (about 1 fps). Normalized 0–1, origin top-left of the shared frame, each line: Region N: x=… y=… w=… h=…',
  ];

  const treatAsWindow =
    displaySurface === 'window' ||
    (metrics?.electronSourceId &&
      String(metrics.electronSourceId).startsWith('window:'));

  const display = !treatAsWindow && vw && vh ? findDisplayForVideoSize(vw, vh) : null;

  if (display && vw && vh) {
    const mapped = [];
    absRects.forEach((abs, idx) => {
      const n = mapAbsRectToDisplayNorm(abs, display);
      if (n) {
        mapped.push(
          `Region ${idx + 1}: x=${n.nx.toFixed(4)} y=${n.ny.toFixed(4)} w=${n.nw.toFixed(4)} h=${n.nh.toFixed(4)}`
        );
      }
    });
    if (mapped.length) {
      lines.push(
        'Aligned to the shared monitor capture (same pixel grid as your images after any uniform scaling).',
        ...mapped,
        'When the user says "region N", answer about the content inside that rectangle on the current frame.'
      );
      return lines.join('\n');
    }
  }

  const cw = canvasW || vb.width;
  const ch = canvasH || vb.height;
  const fallback = absRects.map((abs, idx) => {
    const nx = (abs.x - vb.x) / vb.width;
    const ny = (abs.y - vb.y) / vb.height;
    const nw = abs.w / vb.width;
    const nh = abs.h / vb.height;
    return `Region ${idx + 1}: x=${nx.toFixed(4)} y=${ny.toFixed(4)} w=${nw.toFixed(4)} h=${nh.toFixed(4)}`;
  });
  lines.push(
    'Full virtual-desktop layout (all monitors). If the user shares only one app window, these may NOT align with the cropped image—tell them to share the entire display for exact alignment.',
    ...fallback
  );
  return lines.join('\n');
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
  const barW = 400;
  const barH = 54;
  focusBarWindow.setBounds({
    x: Math.round(b.x + 12),
    y: Math.round(b.y + b.height - barH - 12),
    width: barW,
    height: barH,
  });
}

function ensureFocusBarWindow() {
  if (focusBarWindow && !focusBarWindow.isDestroyed()) return focusBarWindow;
  focusBarWindow = new BrowserWindow({
    width: 400,
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
    x: vb.x,
    y: vb.y,
    width: vb.width,
    height: vb.height,
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
  overlayWindow.setBounds({
    x: vb.x,
    y: vb.y,
    width: vb.width,
    height: vb.height,
  });
  overlayWindow.webContents.send('overlay:reposition', {
    width: vb.width,
    height: vb.height,
  });
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
    backgroundColor: '#0c0d10',
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

ipcMain.on('iris:set-session-live', (_e, live) => {
  sessionLive = !!live;
  if (!sessionLive) {
    captureMetrics = null;
    hideFocusBar();
    hideOverlayFully();
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
    displaySurface: metrics.displaySurface || null,
    electronSourceId: metrics.electronSourceId || null,
  };
});

ipcMain.handle('iris:focus-rects-update', async (_e, payload) => {
  const rects = payload?.rects || [];
  const cw = payload?.canvasWidth;
  const ch = payload?.canvasHeight;
  const text = buildFocusGroundingMessage(rects, cw, ch, captureMetrics);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('iris:apply-focus-grounding', text);
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
