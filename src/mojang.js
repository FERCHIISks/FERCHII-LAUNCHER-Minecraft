const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { detectLoaderType, extractBaseVersion } = require('./modloaders');


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
      
      if (fs.existsSync(vJson)) {
        let vData = null;
        try {
          vData = JSON.parse(fs.readFileSync(vJson, 'utf8'));
        } catch (e) {}

        const loader = detectLoaderType(vId, vData);
        const baseVersion = extractBaseVersion(vId, vData);
        const hasJar = fs.existsSync(vJar);
        const hasInherits = !!(vData && vData.inheritsFrom);

        if (hasJar || hasInherits) {
          list.push({
            id: vId,
            isLocal: true,
            jsonPath: vJson,
            jarPath: hasJar ? vJar : null,
            loader: loader,
            baseVersion: baseVersion,
            inheritsFrom: vData?.inheritsFrom || null,
            type: vData?.type || (loader !== 'vanilla' ? loader : 'custom'),
            releaseTime: vData?.releaseTime || null
          });
        }
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

  return new Promise((resolve) => {
    const psCmd = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${jarPath.replace(/'/g, "''")}', '${nativesDir.replace(/'/g, "''")}')`;
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      windowsHide: true
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

function mavenToPath(name) {
  if (!name || typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts.length < 3) return null;
  const group = parts[0].replace(/\./g, '/');
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts[3] ? `-${parts[3]}` : '';
  const ext = (parts[4] || 'jar').replace(/^@/, '');
  const filename = `${artifact}-${version}${classifier}.${ext}`;
  return `${group}/${artifact}/${version}/${filename}`;
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
    // Si es un loader no instalado localmente, intentar obtener su perfil oficial
    if (versionId.startsWith('fabric-loader-')) {
      const match = versionId.match(/^fabric-loader-([^-]+)-(.+)$/i);
      if (match) {
        if (onStatus) onStatus(`Descargando perfil de Fabric para Minecraft ${match[2]}...`, 10);
        const { getFabricProfile } = require('./modloaders');
        versionData = await getFabricProfile(match[2], match[1]);
        fs.mkdirSync(versionsDir, { recursive: true });
        fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2), 'utf8');
      }
    } else if (versionId.startsWith('quilt-loader-')) {
      const match = versionId.match(/^quilt-loader-([^-]+)-(.+)$/i);
      if (match) {
        if (onStatus) onStatus(`Descargando perfil de Quilt para Minecraft ${match[2]}...`, 10);
        const { getQuiltProfile } = require('./modloaders');
        versionData = await getQuiltProfile(match[2], match[1]);
        fs.mkdirSync(versionsDir, { recursive: true });
        fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2), 'utf8');
      }
    }

    // Si aún no hay versionData, buscar en el catálogo oficial de Mojang
    if (!versionData) {
      if (onStatus) onStatus('Buscando versión en los servidores de Mojang...', 5);
      const manifest = await getVersionManifest();
      const verEntry = manifest.versions.find(v => v.id === versionId);
      if (!verEntry) {
        throw new Error(`La versión "${versionId}" no existe en el catálogo oficial ni en los cargadores soportados.`);
      }

      if (onStatus) onStatus(`Descargando manifiesto de versión ${versionId}...`, 10);
      versionData = await httpsGetJson(verEntry.url);
      fs.mkdirSync(versionsDir, { recursive: true });
      fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2), 'utf8');
    }
  }

  const librariesDir = path.join(gameDir, 'libraries');

  // --- CASO MODLOADER: Versión con herencia (inheritsFrom) ---
  if (versionData.inheritsFrom) {
    const baseId = versionData.inheritsFrom;
    if (onStatus) onStatus(`Preparando versión base de Minecraft (${baseId})...`, 15);

    // Preparar versión base de Mojang (JAR, librerías, assets y nativos)
    const baseResult = await prepareVersion(baseId, gameDir, onStatus);

    const loaderClasspaths = [];
    const missingLibsToDownload = [];

    for (const lib of (versionData.libraries || [])) {
      if (!isLibraryAllowed(lib)) continue;

      let libRelPath = null;
      let libUrl = null;

      if (lib.downloads?.artifact) {
        libRelPath = lib.downloads.artifact.path;
        libUrl = lib.downloads.artifact.url;
      } else if (lib.name) {
        libRelPath = mavenToPath(lib.name);
        let baseUrl = lib.url || 'https://libraries.minecraft.net/';
        if (!baseUrl.endsWith('/')) baseUrl += '/';
        libUrl = `${baseUrl}${libRelPath}`;
      }

      if (libRelPath) {
        const destPath = path.join(librariesDir, ...libRelPath.split('/'));
        loaderClasspaths.push(destPath);
        if (!fs.existsSync(destPath) && libUrl) {
          missingLibsToDownload.push({ url: libUrl, destPath });
        }
      }
    }

    if (missingLibsToDownload.length > 0) {
      if (onStatus) onStatus(`Descargando librerías del cargador de mods (0/${missingLibsToDownload.length})...`, 40);
      await batchDownload(missingLibsToDownload, 10, (done, total) => {
        const percent = 40 + Math.round((done / total) * 30);
        if (onStatus) onStatus(`Descargando librerías del cargador (${done}/${total})...`, percent);
      });
    }

    // Combinar argumentos y metadatos
    const mergedVersionData = {
      ...baseResult.versionData,
      ...versionData,
      id: versionId,
      mainClass: versionData.mainClass || baseResult.versionData.mainClass,
      assetIndex: versionData.assetIndex || baseResult.versionData.assetIndex,
      arguments: {
        jvm: [
          ...(baseResult.versionData.arguments?.jvm || []),
          ...(versionData.arguments?.jvm || [])
        ],
        game: [
          ...(baseResult.versionData.arguments?.game || []),
          ...(versionData.arguments?.game || [])
        ]
      }
    };

    if (versionData.minecraftArguments || baseResult.versionData.minecraftArguments) {
      mergedVersionData.minecraftArguments = [
        baseResult.versionData.minecraftArguments || '',
        versionData.minecraftArguments || ''
      ].filter(Boolean).join(' ');
    }

    // Classpath: primero las del cargador, luego las de la versión base
    const finalClasspaths = [...loaderClasspaths, ...baseResult.classpaths];

    if (onStatus) onStatus('Cargador de mods y archivos verificados.', 98);

    return {
      versionData: mergedVersionData,
      classpaths: finalClasspaths,
      versionJarPath: baseResult.versionJarPath,
      nativesDir: baseResult.nativesDir
    };
  }

  // --- CASO VANILLA: Versión base estándar ---

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
  const classpaths = [];
  const missingLibsToDownload = [];
  const nativesToExtract = [];

  for (const lib of (versionData.libraries || [])) {
    if (!isLibraryAllowed(lib)) continue;

    // Descarga estándar por artifact
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
    } else if (lib.name) {
      // Soporte Maven para librerías sin artifact explícito
      const relPath = mavenToPath(lib.name);
      if (relPath) {
        const libPath = path.join(librariesDir, ...relPath.split('/'));
        classpaths.push(libPath);
        if (!fs.existsSync(libPath)) {
          let baseUrl = lib.url || 'https://libraries.minecraft.net/';
          if (!baseUrl.endsWith('/')) baseUrl += '/';
          missingLibsToDownload.push({
            url: `${baseUrl}${relPath}`,
            destPath: libPath
          });
        }
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

