const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const kill = require('tree-kill');

let win;
let engineProc;
let apiProc;

const ENGINE_HOST = '127.0.0.1';
const ENGINE_PORT = process.env.ENGINE_PORT || '8001';
const API_HOST = '127.0.0.1';
const API_PORT = process.env.API_PORT || '3010';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res && (res.status === 200 || res.status === 404)) return true;
    } catch (e) {}
    await sleep(500);
  }
  return false;
}

function getPaths() {
  if (!app.isPackaged) {
    // repo layout: apps/desktop/src/main.js
    const root = path.resolve(__dirname, '..', '..');
    return {
      root,
      apiDist: path.join(root, 'api', 'dist'),
      apiEntry: path.join(root, 'api', 'dist', 'main.js'),
      engineDir: path.join(root, 'engine'),
    };
  }

  // packaged: extraResources copied under process.resourcesPath
  const root = process.resourcesPath;
  return {
    root,
    apiDist: path.join(root, 'api', 'dist'),
    apiEntry: path.join(root, 'api', 'dist', 'main.js'),
    engineDir: path.join(root, 'engine'),
  };
}

function startEngine(paths) {
  const py = process.env.NEXORA_PYTHON || 'python';
  const engineMain = path.join(paths.engineDir, 'main.py');

  engineProc = spawn(py, ['-m', 'uvicorn', 'main:app', '--host', ENGINE_HOST, '--port', ENGINE_PORT], {
    cwd: paths.engineDir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  engineProc.stdout.on('data', d => console.log('[engine]', d.toString()));
  engineProc.stderr.on('data', d => console.log('[engine]', d.toString()));

  engineProc.on('exit', (code) => {
    console.log('Engine exited', code);
  });
}

function startApi(paths) {
  const node = process.env.NEXORA_NODE || 'node';

  apiProc = spawn(node, [paths.apiEntry], {
    cwd: path.dirname(paths.apiEntry),
    env: {
      ...process.env,
      PORT: API_PORT,
      ENGINE_URL: `http://${ENGINE_HOST}:${ENGINE_PORT}`,
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  apiProc.stdout.on('data', d => console.log('[api]', d.toString()));
  apiProc.stderr.on('data', d => console.log('[api]', d.toString()));

  apiProc.on('exit', (code) => {
    console.log('API exited', code);
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url = `http://${API_HOST}:${API_PORT}`;
  await win.loadURL(url);
}

function shutdown() {
  const procs = [apiProc, engineProc].filter(Boolean);
  for (const p of procs) {
    try {
      kill(p.pid);
    } catch (e) {}
  }
}

app.on('before-quit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

app.whenReady().then(async () => {
  const paths = getPaths();

  try {
    startEngine(paths);
    const okEngine = await waitForHttp(`http://${ENGINE_HOST}:${ENGINE_PORT}/docs`, 45000);
    if (!okEngine) {
      dialog.showErrorBox(
        'NexoraDB Engine no inició',
        'No pude iniciar el Engine (FastAPI) en 127.0.0.1:8001.\n\nVerifica: Python 3.10+, dependencias instaladas (pip -r requirements.txt) y puertos libres.'
      );
      app.quit();
      return;
    }

    startApi(paths);
    const okApi = await waitForHttp(`http://${API_HOST}:${API_PORT}`, 45000);
    if (!okApi) {
      dialog.showErrorBox(
        'NexoraDB API no inició',
        'No pude iniciar el API (Node/Nest) en 127.0.0.1:3010.\n\nVerifica: Node 18+ y que se hayan instalado dependencias (npm install en apps/api).'
      );
      app.quit();
      return;
    }

    await createWindow();
  } catch (e) {
    dialog.showErrorBox('Error iniciando NexoraDB Studio', String(e?.stack || e));
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On Windows/Linux, quit.
  app.quit();
});
