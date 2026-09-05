const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { loadConfig, saveConfig, getTotalSystemRAMGB } = require('./config');
const { createOfflineAccount, startMicrosoftDeviceCode, pollMicrosoftToken } = require('./auth');
const { getVersionManifest, getLocalVersions } = require('./mojang');
const { getModsList, toggleMod, getResourcePacksList, openFolder } = require('./modsManager');
const {
  getFabricGameVersions,
  getFabricLoaders,
  getQuiltGameVersions,
  getQuiltLoaders,
  installLoader,
  detectLoaderType,
  extractBaseVersion
} = require('./modloaders');
const gameLauncher = require('./gameLauncher');
const updater = require('./updater');


const PORT = 38491;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const sseClients = [];

function broadcastSSE(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const res = sseClients[i];
    try {
      res.write(payload);
    } catch (e) {
      sseClients.splice(i, 1);
    }
  }
}

gameLauncher.onStatus((status) => {
  broadcastSSE('status', status);
});

gameLauncher.onLog((logEntry) => {
  broadcastSSE('log', logEntry);
});

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // SSE Event Stream
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
    return;
  }

  // --- API Endpoints ---
  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/config' && method === 'GET') {
        const config = loadConfig();
        return sendJson(res, 200, { success: true, config, totalSystemRam: getTotalSystemRAMGB() });
      }

      if (pathname === '/api/config' && method === 'POST') {
        const body = await parseBody(req);
        const config = loadConfig();
        const updated = { ...config, ...body };
        saveConfig(updated);
        return sendJson(res, 200, { success: true, config: updated });
      }

      if (pathname === '/api/versions' && method === 'GET') {
        const config = loadConfig();
        let remoteManifest = { versions: [] };
        try {
          remoteManifest = await getVersionManifest();
        } catch (e) {}

        const localVersions = getLocalVersions(config.gameDir);
        const classifiedRemotes = (remoteManifest.versions || []).map(v => ({
          ...v,
          loader: 'vanilla',
          baseVersion: v.id
        }));

        return sendJson(res, 200, {
          success: true,
          versions: classifiedRemotes,
          localVersions: localVersions
        });
      }

      // Endpoints de Mod Loaders (Fabric & Quilt)
      if (pathname === '/api/modloaders/fabric/games' && method === 'GET') {
        try {
          const games = await getFabricGameVersions();
          return sendJson(res, 200, { success: true, games });
        } catch (err) {
          return sendJson(res, 500, { success: false, message: err.message });
        }
      }

      if (pathname === '/api/modloaders/fabric/loaders' && method === 'GET') {
        try {
          const gameVersion = parsedUrl.query.gameVersion;
          const loaders = await getFabricLoaders(gameVersion);
          return sendJson(res, 200, { success: true, loaders });
        } catch (err) {
          return sendJson(res, 500, { success: false, message: err.message });
        }
      }

      if (pathname === '/api/modloaders/quilt/games' && method === 'GET') {
        try {
          const games = await getQuiltGameVersions();
          return sendJson(res, 200, { success: true, games });
        } catch (err) {
          return sendJson(res, 500, { success: false, message: err.message });
        }
      }

      if (pathname === '/api/modloaders/quilt/loaders' && method === 'GET') {
        try {
          const gameVersion = parsedUrl.query.gameVersion;
          const loaders = await getQuiltLoaders(gameVersion);
          return sendJson(res, 200, { success: true, loaders });
        } catch (err) {
          return sendJson(res, 500, { success: false, message: err.message });
        }
      }

      if (pathname === '/api/modloaders/install' && method === 'POST') {
        try {
          const body = await parseBody(req);
          const config = loadConfig();
          const { loaderType, gameVersion, loaderVersion, setAsSelected } = body;

          if (!loaderType || !gameVersion) {
            return sendJson(res, 400, { success: false, message: 'Faltan parámetros loaderType o gameVersion' });
          }

          const result = await installLoader(config.gameDir, loaderType, gameVersion, loaderVersion);

          if (setAsSelected !== false) {
            config.selectedVersion = result.versionId;
            saveConfig(config);
          }

          return sendJson(res, 200, {
            success: true,
            result,
            selectedVersion: config.selectedVersion
          });
        } catch (err) {
          return sendJson(res, 500, { success: false, message: err.message });
        }
      }

      if (pathname === '/api/accounts/offline' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.username) {
          return sendJson(res, 400, { success: false, message: 'Nombre de usuario requerido' });
        }
        const account = createOfflineAccount(body.username);
        const config = loadConfig();
        config.accounts = config.accounts.filter(a => a.username.toLowerCase() !== account.username.toLowerCase());
        config.accounts.push(account);
        config.selectedAccountId = account.id;
        saveConfig(config);
        return sendJson(res, 200, { success: true, account, config });
      }

      if (pathname === '/api/accounts/select' && method === 'POST') {
        const body = await parseBody(req);
        const config = loadConfig();
        const found = config.accounts.find(a => a.id === body.id);
        if (found) {
          config.selectedAccountId = found.id;
          saveConfig(config);
          return sendJson(res, 200, { success: true, selectedAccountId: found.id });
        }
        return sendJson(res, 404, { success: false, message: 'Cuenta no encontrada' });
      }

      if (pathname.startsWith('/api/accounts/') && method === 'DELETE') {
        const accountId = pathname.replace('/api/accounts/', '');
        const config = loadConfig();
        config.accounts = config.accounts.filter(a => a.id !== accountId);
        if (config.selectedAccountId === accountId) {
          config.selectedAccountId = config.accounts.length > 0 ? config.accounts[0].id : null;
        }
        saveConfig(config);
        return sendJson(res, 200, { success: true, config });
      }

      if (pathname === '/api/accounts/microsoft/device-code' && method === 'POST') {
        const codeInfo = await startMicrosoftDeviceCode();
        return sendJson(res, 200, codeInfo);
      }

      if (pathname === '/api/accounts/microsoft/poll' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.deviceCode) {
          return sendJson(res, 400, { success: false, message: 'Device code requerido' });
        }
        const result = await pollMicrosoftToken(body.deviceCode);
        if (result.status === 'complete' && result.account) {
          const config = loadConfig();
          config.accounts = config.accounts.filter(a => a.id !== result.account.id);
          config.accounts.push(result.account);
          config.selectedAccountId = result.account.id;
          saveConfig(config);
        }
        return sendJson(res, 200, result);
      }

      // Mods & Resource Packs Endpoints
      if (pathname === '/api/mods' && method === 'GET') {
        const config = loadConfig();
        const mods = getModsList(config.gameDir);
        return sendJson(res, 200, { success: true, mods });
      }

      if (pathname === '/api/mods/toggle' && method === 'POST') {
        const body = await parseBody(req);
        const config = loadConfig();
        const result = toggleMod(config.gameDir, body.filename, body.enable);
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/mods/open-folder' && method === 'POST') {
        const config = loadConfig();
        openFolder(path.join(config.gameDir, 'mods'));
        return sendJson(res, 200, { success: true });
      }

      if (pathname === '/api/resourcepacks' && method === 'GET') {
        const config = loadConfig();
        const packs = getResourcePacksList(config.gameDir);
        return sendJson(res, 200, { success: true, packs });
      }

      if (pathname === '/api/resourcepacks/open-folder' && method === 'POST') {
        const config = loadConfig();
        openFolder(path.join(config.gameDir, 'resourcepacks'));
        return sendJson(res, 200, { success: true });
      }

      if (pathname === '/api/launch' && method === 'POST') {
        const body = await parseBody(req);
        const config = loadConfig();
        const versionId = body.versionId || config.selectedVersion;
        const account = config.accounts.find(a => a.id === config.selectedAccountId);

        if (!account) {
          return sendJson(res, 400, { success: false, message: 'Por favor, añade o selecciona una cuenta antes de iniciar el juego.' });
        }

        config.selectedVersion = versionId;
        saveConfig(config);

        gameLauncher.launch(versionId, account, config).catch((err) => {
          console.error('[Launch error]', err);
        });

        return sendJson(res, 200, { success: true, message: 'Lanzamiento iniciado' });
      }

      if (pathname === '/api/status' && method === 'GET') {
        return sendJson(res, 200, { success: true, status: gameLauncher.getStatus() });
      }

      if (pathname === '/api/logs' && method === 'GET') {
        return sendJson(res, 200, { success: true, logs: gameLauncher.getLogs() });
      }

      if (pathname === '/api/logs/clear' && method === 'POST') {
        gameLauncher.clearLogs();
        return sendJson(res, 200, { success: true });
      }

      if (pathname === '/api/updates/check' && method === 'GET') {
        const force = parsedUrl.query && parsedUrl.query.force === 'true';
        const updateInfo = await updater.checkForUpdates(force);
        return sendJson(res, 200, { success: true, update: updateInfo });
      }

      if (pathname === '/api/updates/apply' && method === 'POST') {
        const body = await parseBody(req);
        const downloadUrl = body.downloadUrl;
        if (!downloadUrl) {
          return sendJson(res, 400, { success: false, message: 'URL de descarga no proporcionada' });
        }

        // Ejecutar actualización reportando por SSE
        updater.applyUpdate(downloadUrl, (message, progress) => {
          broadcastSSE('updateProgress', { message, progress });
        }).then((result) => {
          broadcastSSE('updateProgress', { message: 'Actualización finalizada con éxito.', progress: 100, done: true });
        }).catch((err) => {
          broadcastSSE('updateProgress', { message: 'Error: ' + err.message, progress: 0, error: true });
        });

        return sendJson(res, 200, { success: true, message: 'Actualización en curso' });
      }

      if (pathname === '/api/exit' && method === 'POST') {
        sendJson(res, 200, { success: true });
        setTimeout(() => process.exit(0), 200);
        return;
      }

      return sendJson(res, 404, { success: false, message: 'Ruta no encontrada' });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  // Static File Serving
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let safePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Acceso denegado');
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      return res.end('Archivo no encontrado');
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    fs.createReadStream(safePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[FERCHII LAUNCHER] Servidor iniciado en http://127.0.0.1:${PORT}`);
});
