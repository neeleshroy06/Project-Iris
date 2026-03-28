const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('irisShell', {
  send: (channel, data) => {
    const allowed = ['focus-bar:add-regions', 'focus-bar:done-drawing', 'focus-bar:stop-share'];
    if (allowed.includes(channel)) ipcRenderer.send(channel, data);
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
