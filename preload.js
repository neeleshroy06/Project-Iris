const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iris', {
  getGeminiApiKey: () => ipcRenderer.invoke('iris:get-api-key'),
  getAppVersion: () => ipcRenderer.invoke('iris:get-app-version'),
  getDesktopSources: () => ipcRenderer.invoke('iris:get-desktop-sources'),
  setSessionLive: (live) => ipcRenderer.send('iris:set-session-live', !!live),
  notifyCaptureMetrics: (metrics) => ipcRenderer.send('iris:capture-metrics', metrics),
  onApplyFocusGrounding: (cb) => {
    const handler = (_, text) => cb(text);
    ipcRenderer.on('iris:apply-focus-grounding', handler);
    return () => ipcRenderer.removeListener('iris:apply-focus-grounding', handler);
  },
});
