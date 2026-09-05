const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const CURRENT_VERSION = '3.3.0';
const GITHUB_REPO = 'FERCHIISks/FERCHII-LAUNCHER-Minecraft';

let cachedUpdateInfo = null;
let lastCheckTime = 0;
const CACHE_DURATION_MS = 60 * 1000; // 1 minuto de caché para no saturar GitHub API

function parseVersion(versionStr) {
  if (!versionStr) return [0, 0, 0];
  const clean = versionStr.replace(/^v/i, '').trim();
  const parts = clean.split('.').map(p => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function isNewerVersion(remoteVer, currentVer) {
  const remote = parseVersion(remoteVer);
  const current = parseVersion(currentVer);
  for (let i = 0; i < 3; i++) {
    if (remote[i] > current[i]) return true;
    if (remote[i] < current[i]) return false;
  }
  return false;
}

async function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'Ferchii-Launcher-App',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Respuesta inválida de GitHub'));
          }
        } else if (res.statusCode === 404) {
          resolve(null);
        } else {
          reject(new Error(`GitHub API HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Tiempo de espera agotado conectando con GitHub'));
    });
    req.end();
  });
}

async function checkForUpdates(force = false) {
  const now = Date.now();
  if (!force && cachedUpdateInfo && (now - lastCheckTime < CACHE_DURATION_MS)) {
    return cachedUpdateInfo;
  }

  try {
    const release = await fetchLatestRelease();
    if (!release) {
      cachedUpdateInfo = {
        hasUpdate: false,
        currentVersion: CURRENT_VERSION,
        latestVersion: CURRENT_VERSION,
        checkedAt: now
      };
      lastCheckTime = now;
      return cachedUpdateInfo;
    }

    const remoteTag = release.tag_name || '';
    const hasUpdate = isNewerVersion(remoteTag, CURRENT_VERSION);

    let zipAsset = null;
    if (release.assets && Array.isArray(release.assets)) {
      zipAsset = release.assets.find(a => a.name.toLowerCase().endsWith('.zip'));
    }

    cachedUpdateInfo = {
      hasUpdate: hasUpdate,
      currentVersion: CURRENT_VERSION,
      latestVersion: remoteTag.replace(/^v/i, ''),
      releaseName: release.name || `Versión ${remoteTag}`,
      releaseNotes: release.body || 'Mejoras y correcciones generales.',
      downloadUrl: zipAsset ? zipAsset.browser_download_url : (release.html_url || ''),
      assetName: zipAsset ? zipAsset.name : '',
      assetSize: zipAsset ? zipAsset.size : 0,
      publishedAt: release.published_at || '',
      checkedAt: now
    };
    lastCheckTime = now;
    return cachedUpdateInfo;
  } catch (err) {
    return {
      hasUpdate: false,
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      error: err.message,
      checkedAt: now
    };
  }
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const followRedirect = (currentUrl) => {
      const parsed = new URL(currentUrl);
      const req = https.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'Ferchii-Launcher-App' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return followRedirect(res.headers.location);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Error descargando archivo HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && typeof onProgress === 'function') {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            onProgress(pct, downloadedBytes, totalBytes);
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath));
        });

        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });

      req.on('error', reject);
    };

    followRedirect(url);
  });
}

async function applyUpdate(downloadUrl, onProgress) {
  const rootDir = path.resolve(__dirname, '..');
  const tempDir = path.join(rootDir, '.update_temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const zipPath = path.join(tempDir, 'update_package.zip');
  const extractDir = path.join(tempDir, 'extracted');

  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });

  if (typeof onProgress === 'function') onProgress('Descargando nueva versión...', 10);

  // 1. Descargar paquete ZIP
  await downloadFile(downloadUrl, zipPath, (pct) => {
    if (typeof onProgress === 'function') {
      const mapped = 10 + Math.round(pct * 0.55); // 10% a 65%
      onProgress(`Descargando actualización: ${pct}%`, mapped);
    }
  });

  if (typeof onProgress === 'function') onProgress('Descomprimiendo archivos de actualización...', 70);

  // 2. Descomprimir usando PowerShell Expand-Archive
  await new Promise((resolve, reject) => {
    const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`;
    exec(cmd, (err) => {
      if (err) return reject(new Error('Fallo al descomprimir paquete: ' + err.message));
      resolve();
    });
  });

  if (typeof onProgress === 'function') onProgress('Instalando archivos del sistema...', 85);

  // 3. Copiar componentes actualizados respetando datos y config
  let sourceDir = extractDir;
  const entries = fs.readdirSync(extractDir);
  if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
    sourceDir = path.join(extractDir, entries[0]);
  }

  // Carpetas y archivos a actualizar
  const itemsToUpdate = ['src', 'public', 'Launcher.exe', 'Launcher.cs', 'WebView2Loader.dll', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'bin', 'runtimes', 'README.md'];

  for (const item of itemsToUpdate) {
    const srcItem = path.join(sourceDir, item);
    const destItem = path.join(rootDir, item);
    if (fs.existsSync(srcItem)) {
      if (fs.statSync(srcItem).isDirectory()) {
        fs.cpSync(srcItem, destItem, { recursive: true, force: true });
      } else {
        try {
          fs.copyFileSync(srcItem, destItem);
        } catch (e) {
          // Launcher.exe puede estar bloqueado durante ejecución de la GUI
        }
      }
    }
  }

  // 4. Limpieza de archivos temporales
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  if (typeof onProgress === 'function') onProgress('Actualización completada con éxito.', 100);

  return { success: true, message: 'Actualización aplicada correctamente.' };
}

module.exports = {
  CURRENT_VERSION,
  checkForUpdates,
  applyUpdate
};
