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

// Si quedaron archivos temporales de una actualización anterior, los limpiamos.
updater.cleanupUpdateTemp();

// Si encontramos la marca de actualización, es que el launcher acaba de
// actualizarse: lo avisamos en la interfaz con el resultado real.
const lastUpdateMarker = updater.consumeUpdateMarker();


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

// Evita lanzar dos actualizaciones a la vez.
let updateInProgress = false;

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
        return sendJson(res, 200, {
          success: true,
          config,
          totalSystemRam: getTotalSystemRAMGB(),
          launcherVersion: updater.CURRENT_VERSION
        });
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

      // Endpoint de Noticias de Mojang (Minecraft News)
      if (pathname === '/api/news' && method === 'GET') {
        try {
          const https = require('https');
          const newsData = await new Promise((resolve) => {
            const req = https.get('https://launchercontent.mojang.com/news.json', {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            }, (res) => {
              let d = '';
              res.on('data', chunk => d += chunk);
              res.on('end', () => {
                try {
                  const parsed = JSON.parse(d);
                  resolve(parsed.entries || []);
                } catch {
                  resolve([]);
                }
              });
            });
            req.on('error', () => resolve([]));
            req.setTimeout(5000, () => {
              req.destroy();
              resolve([]);
            });
          });

          const fallbackImages = [
            'https://launchercontent.mojang.com/images/4bBqdKap4YSe87kbAvlyzz-MinecraftEducationPlanetEarth3Launcher772x350.jpeg',
            'https://launchercontent.mojang.com/images/Vpwr1WhNMueVhvRNbCSZH-MinecraftEducationPlanetEarth3Launcher700x466.jpeg',
            'https://images.unsplash.com/photo-1627856013091-fed6e4e30025?auto=format&fit=crop&w=800&q=80',
            'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&w=800&q=80'
          ];

          const finalNews = (newsData && newsData.length > 0) ? newsData.slice(0, 8).map((item, idx) => {
            let img = '';
            if (item.newsPageImage && item.newsPageImage.url) {
              img = item.newsPageImage.url.startsWith('http') ? item.newsPageImage.url : 'https://launchercontent.mojang.com' + item.newsPageImage.url;
            } else if (item.playPageImage && item.playPageImage.url) {
              img = item.playPageImage.url.startsWith('http') ? item.playPageImage.url : 'https://launchercontent.mojang.com' + item.playPageImage.url;
            } else {
              img = fallbackImages[idx % fallbackImages.length];
            }
            return {
              ...item,
              imageUrl: img,
              readMoreUrl: item.readMoreLink || item.cardPath || 'https://www.minecraft.net'
            };
          }) : [
            {
              title: "Minecraft Java Edition: Novedades",
              tag: "Oficial",
              category: "Java Edition",
              text: "Descubre las últimas mejoras, snapshots y novedades oficiales para Java Edition.",
              imageUrl: fallbackImages[0],
              readMoreUrl: "https://www.minecraft.net"
            },
            {
              title: "Servidor Comunitario INGENIEROSMC",
              tag: "Comunidad",
              category: "Servidor",
              text: "Únete a la comunidad de Ferchii en nuestro servidor crossplay Java y Bedrock.",
              imageUrl: fallbackImages[2],
              readMoreUrl: "https://www.minecraft.net"
            }
          ];

          return sendJson(res, 200, { success: true, news: finalNews });
        } catch (err) {
          return sendJson(res, 500, { success: false, message: err.message });
        }
      }

      // Endpoints del Gestor de Perfiles (Instancias Independientes)
      if (pathname === '/api/profiles' && method === 'GET') {
        const config = loadConfig();
        return sendJson(res, 200, {
          success: true,
          profiles: config.profiles || [],
          activeProfileId: config.activeProfileId || null
        });
      }

      if (pathname === '/api/profiles' && method === 'POST') {
        const body = await parseBody(req);
        const config = loadConfig();
        if (!config.profiles) config.profiles = [];

        const defaultGameDir = require('./config').getDefaultGameDir();
        const profileId = 'prof_' + Date.now();
        const profileName = (body.name || 'Nuevo Perfil').trim().slice(0, 24);
        const profileFolder = body.isolateFolder 
          ? path.join(defaultGameDir, 'profiles', profileName.replace(/[^a-zA-Z0-9_-]/g, '_'))
          : defaultGameDir;

        if (body.isolateFolder && !fs.existsSync(profileFolder)) {
          fs.mkdirSync(profileFolder, { recursive: true });
        }

        const newProfile = {
          id: profileId,
          name: profileName,
          version: body.version || config.selectedVersion || '26.2',
          gameDir: profileFolder,
          ram: body.ram || config.ram || 4,
          icon: body.icon || 'creeper',
          createdAt: Date.now()
        };

        config.profiles.push(newProfile);
        if (body.selectImmediately !== false) {
          config.activeProfileId = newProfile.id;
          config.gameDir = newProfile.gameDir;
          config.selectedVersion = newProfile.version;
          config.ram = newProfile.ram;
        }
        saveConfig(config);
        return sendJson(res, 200, { success: true, profile: newProfile, config });
      }

      if (pathname === '/api/profiles/select' && method === 'POST') {
        const body = await parseBody(req);
        const config = loadConfig();
        const found = (config.profiles || []).find(p => p.id === body.id);
        if (found) {
          config.activeProfileId = found.id;
          config.gameDir = found.gameDir;
          config.selectedVersion = found.version;
          if (found.ram) config.ram = found.ram;
          saveConfig(config);
          return sendJson(res, 200, { success: true, config });
        } else if (body.id === 'default') {
          config.activeProfileId = null;
          config.gameDir = require('./config').getDefaultGameDir();
          saveConfig(config);
          return sendJson(res, 200, { success: true, config });
        }
        return sendJson(res, 404, { success: false, message: 'Perfil no encontrado' });
      }

      if (pathname.startsWith('/api/profiles/') && method === 'DELETE') {
        const profileId = pathname.replace('/api/profiles/', '');
        const config = loadConfig();
        if (config.profiles) {
          config.profiles = config.profiles.filter(p => p.id !== profileId);
        }
        if (config.activeProfileId === profileId) {
          config.activeProfileId = null;
          config.gameDir = require('./config').getDefaultGameDir();
        }
        saveConfig(config);
        return sendJson(res, 200, { success: true, config });
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

      if (pathname === '/api/updates/log' && method === 'GET') {
        const logInfo = updater.readUpdateLog();
        return sendJson(res, 200, {
          success: true,
          exists: logInfo.exists,
          status: logInfo.status,
          log: logInfo.log
        });
      }

      if (pathname === '/api/updates/last-result' && method === 'GET') {
        const logInfo = updater.readUpdateLog();
        return sendJson(res, 200, {
          success: true,
          justUpdated: !!lastUpdateMarker.pending,
          updatedTo: lastUpdateMarker.version || '',
          status: logInfo.status,
          log: logInfo.log
        });
      }

      if (pathname === '/api/updates/apply' && method === 'POST') {
        await parseBody(req).catch(() => ({}));

        if (updateInProgress) {
          return sendJson(res, 200, { success: false, message: 'Ya hay una actualización en curso.' });
        }
        updateInProgress = true;

        // La URL de descarga la resuelve el propio servidor contra GitHub:
        // el cliente no puede indicar de dónde bajar el paquete.
        updater.applyUpdate((message, progress) => {
          broadcastSSE('updateProgress', { message, progress });
        }).then((result) => {
          broadcastSSE('updateProgress', {
            message: 'Instalación lista. Reiniciando el launcher para aplicarla...',
            progress: 100,
            done: true,
            restarting: !!result.restartRequired
          });

          // Damos tiempo a que la interfaz reciba el aviso antes de apagar Node.
          // El script de actualización se encarga de cerrar Launcher.exe,
          // reemplazar los archivos y volver a abrirlo.
          setTimeout(() => process.exit(0), 2000);
        }).catch((err) => {
          updateInProgress = false;
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
