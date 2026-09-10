const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');

const CURRENT_VERSION = '3.6.4';
const GITHUB_REPO = 'FERCHIISks/FERCHII-LAUNCHER-Minecraft';
const APP_EXE_NAME = 'Launcher.exe';

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const TEMP_DIR = path.join(ROOT_DIR, '.update_temp');
const UPDATE_LOG = path.join(DATA_DIR, 'update.log');
const UPDATE_MARKER = path.join(DATA_DIR, 'update_pending.json');

// Dominios desde los que se permite descargar el paquete de actualización.
// Evita que una URL arbitraria pueda sobrescribir los archivos del launcher.
const ALLOWED_DOWNLOAD_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'api.github.com',
  'raw.githubusercontent.com'
];

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

// ---------------------------------------------------------------
// Comprobación de la última release publicada en GitHub
// ---------------------------------------------------------------
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

function pickZipAsset(release) {
  if (!release || !Array.isArray(release.assets)) return null;
  const zips = release.assets.filter(a => a.name && a.name.toLowerCase().endsWith('.zip'));
  if (zips.length === 0) return null;
  // Preferimos el paquete "Clean" (sin cuentas ni configuración de ejemplo).
  return zips.find(a => a.name.toLowerCase().includes('clean')) || zips[0];
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
        canAutoUpdate: false,
        checkedAt: now
      };
      lastCheckTime = now;
      return cachedUpdateInfo;
    }

    const remoteTag = release.tag_name || '';
    const hasUpdate = isNewerVersion(remoteTag, CURRENT_VERSION);
    const zipAsset = pickZipAsset(release);

    cachedUpdateInfo = {
      hasUpdate: hasUpdate,
      currentVersion: CURRENT_VERSION,
      latestVersion: remoteTag.replace(/^v/i, ''),
      releaseName: release.name || `Versión ${remoteTag}`,
      releaseNotes: release.body || 'Mejoras y correcciones generales.',
      downloadUrl: zipAsset ? zipAsset.browser_download_url : '',
      assetName: zipAsset ? zipAsset.name : '',
      assetSize: zipAsset ? zipAsset.size : 0,
      canAutoUpdate: !!zipAsset,
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
      canAutoUpdate: false,
      error: err.message,
      checkedAt: now
    };
  }
}

// ---------------------------------------------------------------
// Utilidades de descarga y extracción
// ---------------------------------------------------------------
function isTrustedDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_DOWNLOAD_HOSTS.includes(hostname)) return false;
  // GitHub redirige los enlaces de release a una URL firmada en estos hosts.
  // La ruta cambia y no incluye necesariamente el nombre del repositorio.
  if (hostname === 'release-assets.githubusercontent.com' || hostname === 'objects.githubusercontent.com') {
    return true;
  }
  // La ruta debe pertenecer a las releases de este repositorio.
  return parsed.pathname.toLowerCase().includes(`/${GITHUB_REPO.toLowerCase()}/releases/`);
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const followRedirect = (currentUrl, redirectsLeft) => {
      if (redirectsLeft <= 0) {
        return reject(new Error('Demasiadas redirecciones al descargar la actualización'));
      }
      if (!isTrustedDownloadUrl(currentUrl)) {
        return reject(new Error('La URL de descarga no pertenece a las releases oficiales del launcher'));
      }

      const parsed = new URL(currentUrl);
      const req = https.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'Ferchii-Launcher-App' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return followRedirect(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
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
      req.setTimeout(180000, () => {
        req.destroy();
        reject(new Error('Tiempo de espera agotado durante la descarga'));
      });
    };

    followRedirect(url, 8);
  });
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim() || 'Fallo ejecutando PowerShell'));
      resolve(stdout);
    });
  });
}

async function extractZip(zipPath, destination) {
  const q = (p) => "'" + String(p).replace(/'/g, "''") + "'";
  await runPowerShell(
    `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(destination)} -Force`
  );
}

// El ZIP publicado debe contener la aplicación. Si no la contiene, abortamos
// antes de tocar ningún archivo.
function resolvePayloadRoot(extractDir) {
  let sourceDir = extractDir;
  const entries = fs.readdirSync(extractDir).filter(e => e !== '__MACOSX');
  if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
    sourceDir = path.join(extractDir, entries[0]);
  }

  const looksLikeLauncher =
    fs.existsSync(path.join(sourceDir, 'src', 'server.js')) ||
    fs.existsSync(path.join(sourceDir, APP_EXE_NAME));

  if (!looksLikeLauncher) {
    throw new Error(
      'El paquete descargado no parece una versión válida del launcher ' +
      '(falta src/server.js o Launcher.exe). Revisa el ZIP que subiste a la release.'
    );
  }
  return sourceDir;
}

// ---------------------------------------------------------------
// Detección del proceso padre (Launcher.exe)
// ---------------------------------------------------------------
function getProcessNameByPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    exec(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const match = stdout.match(/"([^"]+\.exe)"/i);
      resolve(match ? match[1] : null);
    });
  });
}

// ---------------------------------------------------------------
// Script de PowerShell que aplica la actualización con el launcher cerrado.
//
// Se ejecuta con -EncodedCommand (base64), así que las rutas con espacios,
// paréntesis o cualquier otro carácter especial no rompen nada.
// ---------------------------------------------------------------
function buildApplyScriptlet(rootDir, sourceDir, launcherPid, version) {
  const q = (p) => "'" + String(p).replace(/'/g, "''") + "'";
  const root = q(rootDir);
  const src = q(sourceDir);
  const pid = parseInt(launcherPid, 10) || 0;
  const ver = q(String(version || ''));

  return `
$ErrorActionPreference = 'Continue'
$root = ${root}
$src  = ${src}
$lpid = ${pid}
$ver  = ${ver}

$logDir = Join-Path $root 'data'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'update.log'

function Write-Log([string]$msg) {
  $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -LiteralPath $script:log -Value $line -Encoding UTF8
}

Write-Log '==== Iniciando aplicacion de la actualizacion ===='
Write-Log ('Destino: ' + $root)

# 1. Esperar a que Node termine de responderle al navegador
Start-Sleep -Seconds 3

# 2. Cerrar Launcher.exe (solo si el PID indicado es realmente Launcher.exe)
if ($lpid -gt 0) {
  $proc = Get-Process -Id $lpid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'Launcher') {
    Write-Log ('Cerrando Launcher.exe (PID ' + $lpid + ') para liberar los archivos...')
    Stop-Process -Id $lpid -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-Process -Id $lpid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Seconds 1
    }
    Write-Log 'Launcher.exe cerrado.'
  } else {
    Write-Log ('El PID ' + $lpid + ' no es Launcher.exe. No se cierra ningun proceso.')
  }
}

# 3. Respaldar la configuracion del usuario (cuentas, perfiles, ajustes)
$cfg = Join-Path $root 'data\\config.json'
$bak = Join-Path $env:TEMP 'ferchii_config_backup.json'
if (Test-Path -LiteralPath $cfg) {
  Copy-Item -LiteralPath $cfg -Destination $bak -Force -ErrorAction SilentlyContinue
}

# 4. Copiar los archivos nuevos sobre la instalacion
Write-Log 'Copiando archivos actualizados...'
$robocopy = Join-Path $env:SystemRoot 'System32\\robocopy.exe'
if (Test-Path -LiteralPath $robocopy) {
  & $robocopy $src $root /E /XF config.json /XF update.log /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $rc = $LASTEXITCODE
  Write-Log ('robocopy finalizado con codigo ' + $rc + '.')
  $copiado = ($rc -lt 8)
} else {
  Write-Log 'robocopy no disponible, la actualizacion no se puede aplicar.'
  $copiado = $false
}

# 5. Restaurar la configuracion del usuario
if (Test-Path -LiteralPath $bak) {
  Copy-Item -LiteralPath $bak -Destination $cfg -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
  Write-Log 'Configuracion, cuentas, perfiles y mundos conservados.'
}

# 6. Limpiar archivos temporales
Remove-Item -LiteralPath (Join-Path $root '.update_temp') -Recurse -Force -ErrorAction SilentlyContinue

# 7. Reabrir el launcher
$exe = Join-Path $root 'Launcher.exe'
if ($copiado) {
  Write-Log ('OK: actualizacion aplicada a la version ' + $ver + '. Reiniciando el launcher...')
} else {
  Write-Log 'ERROR: no se pudieron copiar los archivos. Se mantiene la version anterior.'
}

if (Test-Path -LiteralPath $exe) {
  Start-Process -FilePath $exe -WorkingDirectory $root
  Write-Log 'Launcher.exe reiniciado.'
} else {
  Write-Log 'AVISO: no se encontro Launcher.exe, abrelo manualmente.'
}
`;
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// ---------------------------------------------------------------
// Aplicar la actualización
// ---------------------------------------------------------------
// La URL de descarga NUNCA se acepta desde el cliente: siempre se resuelve
// contra la API de GitHub del repositorio oficial. Así una URL manipulada no
// puede sobrescribir los archivos del launcher, y tampoco se puede instalar
// una versión más antigua que la que ya tienes.
async function applyUpdate(onProgress) {
  const report = (message, progress) => {
    if (typeof onProgress === 'function') onProgress(message, progress);
  };

  const info = await checkForUpdates(true);

  if (info && info.error) {
    throw new Error(`No se pudo consultar GitHub: ${info.error}`);
  }
  if (!info || !info.downloadUrl) {
    throw new Error('La última release no incluye un archivo .zip del launcher. Súbelo a GitHub y vuelve a intentarlo.');
  }
  if (!info.hasUpdate) {
    throw new Error(`Ya tienes la última versión disponible (v${CURRENT_VERSION}).`);
  }

  const downloadUrl = info.downloadUrl;
  const targetVersion = info.latestVersion || CURRENT_VERSION;
  const rootDir = ROOT_DIR;

  if (!isTrustedDownloadUrl(downloadUrl)) {
    throw new Error('La URL del paquete de actualización no pertenece a las releases oficiales del launcher.');
  }

  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const zipPath = path.join(TEMP_DIR, 'update_package.zip');
  const extractDir = path.join(TEMP_DIR, 'payload');

  try {
    // 2. Descargar
    report('Descargando nueva versión desde GitHub...', 5);
    await downloadFile(downloadUrl, zipPath, (pct) => {
      const mapped = 5 + Math.round(pct * 0.55); // 5% -> 60%
      report(`Descargando actualización: ${pct}%`, mapped);
    });

    // 3. Descomprimir
    report('Descomprimiendo archivos de actualización...', 65);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    report('Verificando el contenido del paquete...', 75);
    const sourceDir = resolvePayloadRoot(extractDir);

    // 4. Averiguar el PID de Launcher.exe (proceso padre del servidor Node).
    //    Solo se cerrará si de verdad es Launcher.exe.
    report('Preparando la instalación...', 88);
    const parentPid = process.ppid;
    const parentName = await getProcessNameByPid(parentPid);
    const launcherPid = (parentName && parentName.toLowerCase() === APP_EXE_NAME.toLowerCase())
      ? String(parentPid)
      : '';

    fs.rmSync(zipPath, { force: true });

    // 5. Dejar constancia en el registro y lanzar el aplicador de la actualización.
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        UPDATE_LOG,
        `[${new Date().toLocaleString()}] Iniciando actualizacion a la version ${targetVersion}.\n`,
        'utf8'
      );
    } catch (e) {}
    writeUpdateMarker(targetVersion);

    report('Aplicando actualización y reiniciando el launcher...', 95);

    const script = buildApplyScriptlet(rootDir, sourceDir, launcherPid, targetVersion);
    const encoded = encodePowerShell(script);

    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: rootDir
    });
    child.unref();

    report('Reiniciando el launcher para completar la instalación...', 100);

    return {
      success: true,
      restartRequired: true,
      message: 'Actualización descargada. El launcher se reiniciará para instalarla.'
    };
  } catch (err) {
    try {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch (e) {}
    throw err;
  }
}

// ---------------------------------------------------------------
// Registro de la última actualización (para mostrarlo en la interfaz)
// ---------------------------------------------------------------
function readUpdateLog(maxLines = 40) {
  try {
    if (!fs.existsSync(UPDATE_LOG)) return { exists: false, log: [], status: 'none' };
    const content = fs.readFileSync(UPDATE_LOG, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const tail = lines.slice(-maxLines);
    const text = tail.join('\n');
    let status = 'unknown';
    if (/OK: actualizacion aplicada/i.test(text)) status = 'success';
    else if (/ERROR:/i.test(text)) status = 'error';
    return { exists: true, log: tail, status };
  } catch (e) {
    return { exists: false, log: [], status: 'none' };
  }
}

// Limpia restos de una actualización anterior al arrancar el servidor.
function cleanupUpdateTemp() {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  } catch (e) {}
}

// Marca que hay una actualización en curso. Si al arrancar el servidor
// encontramos esta marca, sabemos que venimos de actualizarnos.
function writeUpdateMarker(version) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_MARKER, JSON.stringify({ version, at: Date.now() }), 'utf8');
  } catch (e) {}
}

function consumeUpdateMarker() {
  try {
    if (!fs.existsSync(UPDATE_MARKER)) return { pending: false };
    const raw = fs.readFileSync(UPDATE_MARKER, 'utf8');
    fs.rmSync(UPDATE_MARKER, { force: true });
    const parsed = JSON.parse(raw);
    return { pending: true, version: parsed.version || '', at: parsed.at || 0 };
  } catch (e) {
    return { pending: false };
  }
}

module.exports = {
  CURRENT_VERSION,
  checkForUpdates,
  applyUpdate,
  readUpdateLog,
  cleanupUpdateTemp,
  consumeUpdateMarker,
  isTrustedDownloadUrl,
  buildApplyScriptlet
};
