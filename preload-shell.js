const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('irisShell', {
  send: (channel, data) => {
    const allowed = [
      'focus-bar:add-regions',
      'focus-bar:done-drawing',
      'focus-bar:stop-share',
      'focus-bar:set-observation-mode',
    ];
    if (allowed.includes(channel)) ipcRenderer.send(channel, data);
  },
  getObservationMode: () => ipcRenderer.invoke('iris:get-observation-mode'),
  onObservationMode: (fn) => {
    const handler = (_, payload) => fn(payload);
    ipcRenderer.on('iris:observation-mode', handler);
    return () => ipcRenderer.removeListener('iris:observation-mode', handler);
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
