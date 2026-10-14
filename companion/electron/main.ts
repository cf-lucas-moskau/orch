import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { readFileSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { placeWindow } from './position.ts';

const stateFile = process.env.ORCH_STATE_FILE ?? join(homedir(), 'agent-bus', 'orch-state.json');
const posFile = () => join(app.getPath('userData'), 'position.json');
const SIZE = { width: 420, height: 520 };

function startPosition() {
  let saved: unknown = null;
  try { saved = JSON.parse(readFileSync(posFile(), 'utf8')); } catch {}
  return placeWindow(saved, SIZE, screen.getAllDisplays().map(d => d.workArea), screen.getPrimaryDisplay().workArea);
}

app.dock?.hide();
app.whenReady().then(() => {
  const win = new BrowserWindow({
    ...SIZE, ...startPosition(),
    transparent: true, frame: false, resizable: false, hasShadow: false, alwaysOnTop: true,
    skipTaskbar: true, fullscreenable: false, focusable: true, show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks fall through to the desktop except over the pet, sprites and panel; the renderer flips this on hover.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());

  let last = '';
  const send = () => {
    let text = '';
    try { text = readFileSync(stateFile, 'utf8'); } catch {}
    if (text === last) return;
    last = text;
    try { win.webContents.send('state', text ? JSON.parse(text) : null); } catch {}
  };
  win.webContents.on('did-finish-load', () => { last = ''; send(); });
  // Syncthing replaces the file by rename, so watch the folder; the poll covers missed events and a missing folder.
  try { watch(dirname(stateFile), (_, f) => { if (!f || f === basename(stateFile)) send(); }); } catch {}
  setInterval(send, 5000);

  ipcMain.on('interactive', (_, on: boolean) => win.setIgnoreMouseEvents(!on, { forward: true }));
  let origin = { x: 0, y: 0 };
  ipcMain.on('drag-start', () => { const [x, y] = win.getPosition(); origin = { x, y }; });
  ipcMain.on('drag', (_, dx: number, dy: number) => win.setPosition(Math.round(origin.x + dx), Math.round(origin.y + dy)));
  ipcMain.on('drag-end', () => {
    const [x, y] = win.getPosition();
    try { writeFileSync(posFile(), JSON.stringify({ x, y })); } catch {}
  });
});
app.on('window-all-closed', () => app.quit());
