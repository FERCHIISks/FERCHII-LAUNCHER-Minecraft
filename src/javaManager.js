const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawn } = require('child_process');

const RUNTIME_DIR = path.join(__dirname, '..', 'data', 'runtime');

function getRequiredJavaMajorVersion(mcVersionStr, versionData) {
  // 1. Si el JSON de la versión o versión base especifica la versión de Java directamente, usar esa
  if (versionData?.javaVersion?.majorVersion) {
    return versionData.javaVersion.majorVersion;
  }

  // 2. Extraer la versión real de Minecraft en caso de cargador de mods (Fabric, Quilt, Forge, etc.)
  let cleanVersion = mcVersionStr;
  if (versionData?.inheritsFrom) {
    cleanVersion = versionData.inheritsFrom;
  } else {
    const { extractBaseVersion } = require('./modloaders');
    cleanVersion = extractBaseVersion(mcVersionStr, versionData);
  }

  const match = cleanVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return 21;


  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = match[3] ? parseInt(match[3], 10) : 0;

  if (major >= 24) {
    // Versiones modernas y snapshots experimentales (como 26.2) usan Java 25
    return 25;
  }

  if (major === 1) {
    if (minor <= 16) {
      return 8;
    } else if (minor < 20 || (minor === 20 && patch <= 4)) {
      return 17;
    } else {
      return 21;
    }
  }

  return 21;
}

function findLocalJava(majorVersion) {
  const javaFolder = path.join(RUNTIME_DIR, `java-${majorVersion}`);
  if (fs.existsSync(javaFolder)) {
    // 1. Buscar en javaFolder/bin/
    const directPath = path.join(javaFolder, 'bin', 'javaw.exe');
    if (fs.existsSync(directPath)) return directPath;
    const directExe = path.join(javaFolder, 'bin', 'java.exe');
    if (fs.existsSync(directExe)) return directExe;

    // 2. Buscar en subdirectorios (ej. jdk-21.0.12.1+1-jre/bin/)
    try {
      const items = fs.readdirSync(javaFolder, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const sub = path.join(javaFolder, item.name, 'bin', 'javaw.exe');
          if (fs.existsSync(sub)) return sub;
          const subExe = path.join(javaFolder, item.name, 'bin', 'java.exe');
          if (fs.existsSync(subExe)) return subExe;
        }
      }
    } catch (e) {}
  }
  return null;
}

function checkBinaryJavaVersion(binPath) {
  try {
    const out = execSync(`"${binPath}" -version 2>&1`, { encoding: 'utf8' });
    const match = out.match(/(?:java|openjdk) version "([^"]+)"/i) || out.match(/(?:java|openjdk) ([0-9.]+)/i);
    if (match) {
      const v = match[1];
      if (v.startsWith('1.8')) return 8;
      const num = parseInt(v.split('.')[0], 10);
      return isNaN(num) ? null : num;
    }
  } catch (e) {}
  return null;
}

function findSystemJava(requiredMajor) {
  // 1. Comprobar variable de entorno JAVA_HOME
  if (process.env.JAVA_HOME) {
    const javaHomeW = path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe');
    if (fs.existsSync(javaHomeW) && checkBinaryJavaVersion(javaHomeW) === requiredMajor) {
      return javaHomeW;
    }
  }

  // 2. Comprobar en PATH
  try {
    const paths = execSync('where.exe javaw.exe 2>nul', { encoding: 'utf8' }).split('\r\n').filter(Boolean);
    for (const p of paths) {
      if (fs.existsSync(p) && checkBinaryJavaVersion(p) === requiredMajor) {
        return p;
      }
    }
  } catch (e) {}

  // 3. Comprobar rutas comunes de instalación en Windows
  const searchDirs = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\BellSoft'
  ];

  for (const sDir of searchDirs) {
    if (fs.existsSync(sDir)) {
      try {
        const subdirs = fs.readdirSync(sDir, { withFileTypes: true });
        for (const sub of subdirs) {
          if (sub.isDirectory()) {
            const candidate = path.join(sDir, sub.name, 'bin', 'javaw.exe');
            if (fs.existsSync(candidate) && checkBinaryJavaVersion(candidate) === requiredMajor) {
              return candidate;
            }
          }
        }
      } catch (e) {}
    }
  }

  return null;
}

function downloadFileWithRedirect(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectCount = 0) {
      if (redirectCount > 10) {
        return reject(new Error('Demasiadas redirecciones HTTP'));
      }

      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Error de descarga HTTP ${res.statusCode} en ${currentUrl}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (onProgress && totalBytes > 0) {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve());
        });

        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    }

    get(url);
  });
}

async function extractZip(zipPath, targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const psCmd = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${targetDir}" -Force`;
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      windowsHide: true
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell Expand-Archive falló con código ${code}`));
    });

    child.on('error', reject);
  });
}

async function ensureJavaRuntime(majorVersion, onProgressMessage) {
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }

  // 1. Verificar si ya existe en data/runtime/java-<majorVersion>
  const existingLocal = findLocalJava(majorVersion);
  if (existingLocal) {
    if (onProgressMessage) onProgressMessage(`Java ${majorVersion} detectado en almacenamiento local.`);
    return existingLocal;
  }

  // 2. Comprobar si ya existe en el sistema operativo del usuario (JAVA_HOME, PATH, Program Files)
  const existingSystem = findSystemJava(majorVersion);
  if (existingSystem) {
    if (onProgressMessage) onProgressMessage(`Java ${majorVersion} detectado en el sistema (${existingSystem}).`);
    return existingSystem;
  }

  // 3. Si NO existe, descargarlo automáticamente
  const url = `https://api.adoptium.net/v3/binary/latest/${majorVersion}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  const zipPath = path.join(RUNTIME_DIR, `java-${majorVersion}.zip`);
  const targetDir = path.join(RUNTIME_DIR, `java-${majorVersion}`);

  if (onProgressMessage) onProgressMessage(`Descargando Java ${majorVersion} portable (optimizado)...`, 5);

  await downloadFileWithRedirect(url, zipPath, (downloaded, total) => {
    const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    const mbDownloaded = (downloaded / (1024 * 1024)).toFixed(1);
    const mbTotal = (total / (1024 * 1024)).toFixed(1);
    if (onProgressMessage) {
      onProgressMessage(`Descargando Java ${majorVersion}: ${mbDownloaded}MB / ${mbTotal}MB (${percent}%)`, percent);
    }
  });

  if (onProgressMessage) onProgressMessage(`Extrayendo Java ${majorVersion}...`, 90);
  await extractZip(zipPath, targetDir);

  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  } catch (e) {}

  const finalJava = findLocalJava(majorVersion);
  if (!finalJava) {
    throw new Error(`Java ${majorVersion} se extrajo pero no se encontró javaw.exe en ${targetDir}`);
  }

  if (onProgressMessage) onProgressMessage(`Java ${majorVersion} preparado correctamente.`, 100);
  return finalJava;
}

module.exports = {
  getRequiredJavaMajorVersion,
  findLocalJava,
  findSystemJava,
  ensureJavaRuntime
};
