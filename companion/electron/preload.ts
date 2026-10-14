import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('companion', {
  onState: (cb: (s: unknown) => void) => ipcRenderer.on('state', (_, s) => cb(s)),
  interactive: (on: boolean) => ipcRenderer.send('interactive', on),
  dragStart: () => ipcRenderer.send('drag-start'),
  drag: (dx: number, dy: number) => ipcRenderer.send('drag', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
