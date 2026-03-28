const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('irisShell', {
  send: (channel, data) => {
    const allowed = [
      'focus-bar:add-regions',
      'focus-bar:done-drawing',
      'focus-bar:stop-share',
      'focus-bar:set-observation-mode',
      'focus-bar:resize',
      'focus-bar:composer-submit',
      'focus-bar:dock-dismiss',
      'overlay:set-mouse-through',
    ];
    if (allowed.includes(channel)) ipcRenderer.send(channel, data);
  },
  getObservationMode: () => ipcRenderer.invoke('iris:get-observation-mode'),
  getDockSnapshot: () => ipcRenderer.invoke('iris:focus-bar-dock-snapshot'),
  openExternal: (url) => ipcRenderer.invoke('iris:open-external', url),
  onObservationMode: (fn) => {
    const handler = (_, payload) => fn(payload);
    ipcRenderer.on('iris:observation-mode', handler);
    return () => ipcRenderer.removeListener('iris:observation-mode', handler);
  },
  onDockSync: (fn) => {
    const handler = (_, items) => fn(items);
    ipcRenderer.on('iris:focus-bar-dock-sync', handler);
    return () => ipcRenderer.removeListener('iris:focus-bar-dock-sync', handler);
  },
  onDockPush: (fn) => {
    const handler = (_, item) => fn(item);
    ipcRenderer.on('iris:focus-bar-dock-push', handler);
    return () => ipcRenderer.removeListener('iris:focus-bar-dock-push', handler);
  },
  onDockClear: (fn) => {
    const handler = () => fn();
    ipcRenderer.on('iris:focus-bar-dock-clear', handler);
    return () => ipcRenderer.removeListener('iris:focus-bar-dock-clear', handler);
  },
  on: (channel, fn) => {
    const allowed = [
      'overlay:set-drawing',
      'overlay:reposition',
      'overlay:clear',
      'overlay:request-grounding',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  invokeFocusRectsUpdate: (payload) =>
    ipcRenderer.invoke('iris:focus-rects-update', payload),
});
