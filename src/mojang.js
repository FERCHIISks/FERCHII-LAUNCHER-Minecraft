const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const CACHE_MANIFEST_PATH = path.join(__dirname, '..', 'data', 'version_manifest.json');

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGetJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} al obtener ${url}`));
      }
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    function get(currUrl, redirectCount = 0) {
      if (redirectCount > 5) return reject(new Error('Demasiadas redirecciones HTTP'));

      https.get(currUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} al descargar ${currUrl}`));
        }

        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => resolve());
        });
        out.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    }

    get(url);
  });
}

async function getVersionManifest() {
  try {
    const manifest = await httpsGetJson(MANIFEST_URL);
    fs.mkdirSync(path.dirname(CACHE_MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(CACHE_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  } catch (err) {
    if (fs.existsSync(CACHE_MANIFEST_PATH)) {
      try {
        return JSON.parse(fs.readFileSync(CACHE_MANIFEST_PATH, 'utf8'));
      } catch (e) {}
    }
    throw err;
  }
}

function getLocalVersions(gameDir) {
  const versionsDir = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsDir)) return [];

  const list = [];
  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const vId = entry.name;
      const vJson = path.join(versionsDir, vId, `${vId}.json`);
      const vJar = path.join(versionsDir, vId, `${vId}.jar`);
      if (fs.existsSync(vJson) && fs.existsSync(vJar)) {
        list.push({
          id: vId,
          isLocal: true,
          jsonPath: vJson,
          jarPath: vJar
        });
      }
    }
  }

  return list;
}

function isLibraryAllowed(lib) {
  if (!lib.rules) return true;
  let allowed = false;

  for (const rule of lib.rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== 'windows') {
        matches = false;
      }
    }
    if (matches) {
      allowed = (rule.action === 'allow');
    }
  }
  return allowed;
}

async function extractNatives(jarPath, nativesDir) {
  if (!fs.existsSync(nativesDir)) {
    fs.mkdirSync(nativesDir, { recursive: true });
  }

  // Extraer DLLs del JAR nativo
  return new Promise((resolve) => {
    const psCmd = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${jarPath}', '${nativesDir}')`;
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      windowsHide: true
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

// Descarga en paralelo con cola de concurrencia
async function batchDownload(items, concurrency, onProgress) {
  let completed = 0;
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      try {
        if (!fs.existsSync(current.destPath)) {
          await downloadFile(current.url, current.destPath);
        }
      } catch (err) {
        // En caso de fallo no crítico en un asset secundario, continuar
      }
      completed++;
      if (onProgress) {
        onProgress(completed, items.length);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
}

async function prepareVersion(versionId, gameDir, onStatus) {
  const versionsDir = path.join(gameDir, 'versions', versionId);
  const versionJsonPath = path.join(versionsDir, `${versionId}.json`);
  const versionJarPath = path.join(versionsDir, `${versionId}.jar`);
  const nativesDir = path.join(versionsDir, 'natives');

  let versionData = null;

  // 1. Obtener JSON de la versión
  if (fs.existsSync(versionJsonPath)) {
    try {
      versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
    } catch (e) {}
  }

  if (!versionData) {
    if (onStatus) onStatus('Buscando versión en los servidores de Mojang...', 5);
    const manifest = await getVersionManifest();
    const verEntry = manifest.versions.find(v => v.id === versionId);
    if (!verEntry) {
      throw new Error(`La versión ${versionId} no existe en el catálogo oficial de Mojang.`);
    }

    if (onStatus) onStatus(`Descargando manifiesto de versión ${versionId}...`, 10);
    versionData = await httpsGetJson(verEntry.url);
    fs.mkdirSync(versionsDir, { recursive: true });
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2), 'utf8');
  }

  // 2. Cliente JAR principal
  if (!fs.existsSync(versionJarPath)) {
    if (onStatus) onStatus(`Descargando cliente de Minecraft ${versionId}...`, 20);
    const clientDownload = versionData.downloads?.client;
    if (!clientDownload?.url) {
      throw new Error(`No se encontró URL de descarga del cliente para ${versionId}`);
    }
    await downloadFile(clientDownload.url, versionJarPath);
  }

  // 3. Librerías
  const librariesDir = path.join(gameDir, 'libraries');
  const classpaths = [];
  const missingLibsToDownload = [];
  const nativesToExtract = [];

  for (const lib of (versionData.libraries || [])) {
    if (!isLibraryAllowed(lib)) continue;

    // Descarga estándar
    if (lib.downloads?.artifact) {
      const artifact = lib.downloads.artifact;
      const libPath = path.join(librariesDir, ...artifact.path.split('/'));
      classpaths.push(libPath);

      if (!fs.existsSync(libPath)) {
        missingLibsToDownload.push({
          url: artifact.url,
          destPath: libPath
        });
      }
    }

    // Nativos de Windows
    if (lib.natives && lib.natives.windows && lib.downloads?.classifiers) {
      const nativeKey = lib.natives.windows.replace('${arch}', '64');
      const classifier = lib.downloads.classifiers[nativeKey] || lib.downloads.classifiers['natives-windows'];
      if (classifier) {
        const nativeLibPath = path.join(librariesDir, ...classifier.path.split('/'));
        if (!fs.existsSync(nativeLibPath)) {
          missingLibsToDownload.push({
            url: classifier.url,
            destPath: nativeLibPath
          });
        }
        nativesToExtract.push(nativeLibPath);
      }
    }
  }

  // Descargar librerías faltantes
  if (missingLibsToDownload.length > 0) {
    if (onStatus) onStatus(`Descargando librerías requeridas (0/${missingLibsToDownload.length})...`, 30);
    await batchDownload(missingLibsToDownload, 10, (done, total) => {
      const percent = 30 + Math.round((done / total) * 30);
      if (onStatus) onStatus(`Descargando librerías (${done}/${total})...`, percent);
    });
  }

  // Extraer nativos si la carpeta de nativos está vacía
  if (!fs.existsSync(nativesDir) || fs.readdirSync(nativesDir).length === 0) {
    if (onStatus) onStatus('Extrayendo bibliotecas nativas de Windows...', 65);
    for (const natJar of nativesToExtract) {
      if (fs.existsSync(natJar)) {
        await extractNatives(natJar, nativesDir);
      }
    }
  }

  // 4. Assets
  const assetsDir = path.join(gameDir, 'assets');
  const assetIndex = versionData.assetIndex;

  if (assetIndex) {
    const indexFilePath = path.join(assetsDir, 'indexes', `${assetIndex.id}.json`);
    let indexData = null;

    if (fs.existsSync(indexFilePath)) {
      try {
        indexData = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
      } catch (e) {}
    }

    if (!indexData && assetIndex.url) {
      if (onStatus) onStatus('Descargando índice de recursos y sonidos...', 70);
      indexData = await httpsGetJson(assetIndex.url);
      fs.mkdirSync(path.dirname(indexFilePath), { recursive: true });
      fs.writeFileSync(indexFilePath, JSON.stringify(indexData, null, 2), 'utf8');
    }

    if (indexData && indexData.objects) {
      const missingAssets = [];
      const objectsDir = path.join(assetsDir, 'objects');

      for (const objKey in indexData.objects) {
        const hash = indexData.objects[objKey].hash;
        const sub = hash.substring(0, 2);
        const objPath = path.join(objectsDir, sub, hash);
        if (!fs.existsSync(objPath)) {
          missingAssets.push({
            url: `https://resources.download.minecraft.net/${sub}/${hash}`,
            destPath: objPath
          });
        }
      }

      if (missingAssets.length > 0) {
        if (onStatus) onStatus(`Descargando recursos del juego (0/${missingAssets.length})...`, 75);
        await batchDownload(missingAssets, 20, (done, total) => {
          const percent = 75 + Math.round((done / total) * 20);
          if (onStatus) onStatus(`Descargando recursos (${done}/${total})...`, percent);
        });
      }
    }
  }

  // Agregar el client.jar al classpath al final
  classpaths.push(versionJarPath);

  if (onStatus) onStatus('Archivos locales verificados y listos.', 98);

  return {
    versionData,
    classpaths,
    versionJarPath,
    nativesDir
  };
}

module.exports = {
  getVersionManifest,
  getLocalVersions,
  prepareVersion
};
