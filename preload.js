const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iris', {
  getGeminiApiKey: () => ipcRenderer.invoke('iris:get-api-key'),
  getAppVersion: () => ipcRenderer.invoke('iris:get-app-version'),
  getDesktopSources: () => ipcRenderer.invoke('iris:get-desktop-sources'),
  setSessionLive: (live) => ipcRenderer.send('iris:set-session-live', !!live),
  minimizeCompact: (payload) => ipcRenderer.send('iris:minimize-compact', payload || {}),
  notifyCaptureMetrics: (metrics) => ipcRenderer.send('iris:capture-metrics', metrics),
  onApplyFocusGrounding: (cb) => {
    const handler = (_, text) => cb(text);
    ipcRenderer.on('iris:apply-focus-grounding', handler);
    return () => ipcRenderer.removeListener('iris:apply-focus-grounding', handler);
  },
  onCaptureFocusRegions: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('iris:set-capture-focus-regions', handler);
    return () => ipcRenderer.removeListener('iris:set-capture-focus-regions', handler);
  },
  onStopScreenShare: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('iris:stop-screen-share', handler);
    return () => ipcRenderer.removeListener('iris:stop-screen-share', handler);
  },
  syncObservationMode: (mode) => ipcRenderer.send('iris:set-observation-mode', mode),
  onObservationMode: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('iris:observation-mode', handler);
    return () => ipcRenderer.removeListener('iris:observation-mode', handler);
  },
  invokeBuildXlsxFromScreen: (payload) =>
    ipcRenderer.invoke('iris:build-xlsx-from-screen', payload),
  invokeExportScreenFile: (payload) => ipcRenderer.invoke('iris:export-screen-file', payload),
});
