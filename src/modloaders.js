const https = require('https');
const fs = require('fs');
const path = require('path');

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'FerchiiLauncher/3.3 (Minecraft Java Launcher)'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGetJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} al consultar ${url}`));
      }
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`Error parseando JSON de ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`Timeout al conectar con ${url}`));
    });
  });
}

// --- Fabric Meta API ---
const FABRIC_META = 'https://meta.fabricmc.net/v2';

async function getFabricGameVersions() {
  const versions = await httpsGetJson(`${FABRIC_META}/versions/game`);
  return versions.map(v => ({
    version: v.version,
    stable: !!v.stable
  }));
}

async function getFabricLoaders(gameVersion) {
  let url = `${FABRIC_META}/versions/loader`;
  if (gameVersion) {
    url += `/${encodeURIComponent(gameVersion)}`;
  }
  const loaders = await httpsGetJson(url);
  return loaders.map(item => {
    const loaderObj = item.loader || item;
    return {
      version: loaderObj.version,
      stable: !!loaderObj.stable,
      maven: loaderObj.maven
    };
  });
}

async function getFabricProfile(gameVersion, loaderVersion) {
  const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  return await httpsGetJson(url);
}

// --- Quilt Meta API ---
const QUILT_META = 'https://meta.quiltmc.org/v3';

async function getQuiltGameVersions() {
  const versions = await httpsGetJson(`${QUILT_META}/versions/game`);
  return versions.map(v => ({
    version: v.version,
    stable: !!v.stable
  }));
}

async function getQuiltLoaders(gameVersion) {
  let url = `${QUILT_META}/versions/loader`;
  if (gameVersion) {
    url += `/${encodeURIComponent(gameVersion)}`;
  }
  const loaders = await httpsGetJson(url);
  return loaders.map(item => {
    const loaderObj = item.loader || item;
    return {
      version: loaderObj.version,
      stable: !!loaderObj.stable,
      maven: loaderObj.maven
    };
  });
}

async function getQuiltProfile(gameVersion, loaderVersion) {
  const url = `${QUILT_META}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  return await httpsGetJson(url);
}

// --- Instalación del Perfil en disco ---
async function installLoader(gameDir, loaderType, gameVersion, loaderVersion) {
  let profileJson = null;

  if (loaderType === 'fabric') {
    if (!loaderVersion) {
      const loaders = await getFabricLoaders(gameVersion);
      const stable = loaders.find(l => l.stable) || loaders[0];
      if (!stable) throw new Error(`No se encontró Fabric Loader para Minecraft ${gameVersion}`);
      loaderVersion = stable.version;
    }
    profileJson = await getFabricProfile(gameVersion, loaderVersion);
  } else if (loaderType === 'quilt') {
    if (!loaderVersion) {
      const loaders = await getQuiltLoaders(gameVersion);
      const stable = loaders.find(l => l.stable) || loaders[0];
      if (!stable) throw new Error(`No se encontró Quilt Loader para Minecraft ${gameVersion}`);
      loaderVersion = stable.version;
    }
    profileJson = await getQuiltProfile(gameVersion, loaderVersion);
  } else {
    throw new Error(`Instalación automática no soportada para ${loaderType}`);
  }

  const versionId = profileJson.id;
  const versionsDir = path.join(gameDir, 'versions', versionId);
  const targetJson = path.join(versionsDir, `${versionId}.json`);

  if (!fs.existsSync(versionsDir)) {
    fs.mkdirSync(versionsDir, { recursive: true });
  }

  fs.writeFileSync(targetJson, JSON.stringify(profileJson, null, 2), 'utf8');

  return {
    success: true,
    versionId,
    inheritsFrom: profileJson.inheritsFrom || gameVersion,
    loaderType,
    loaderVersion,
    gameVersion
  };
}

// --- Detección Inteligente del Tipo de Loader ---
function detectLoaderType(versionId, versionData = null) {
  const vLower = (versionId || '').toLowerCase();
  
  if (vLower.includes('fabric')) return 'fabric';
  if (vLower.includes('quilt')) return 'quilt';
  if (vLower.includes('neoforge')) return 'neoforge';
  if (vLower.includes('forge')) return 'forge';
  if (vLower.includes('optifine')) return 'optifine';

  if (versionData) {
    const mainClass = (versionData.mainClass || '').toLowerCase();
    if (mainClass.includes('fabricmc')) return 'fabric';
    if (mainClass.includes('quiltmc')) return 'quilt';
    if (mainClass.includes('neoforged')) return 'neoforge';
    if (mainClass.includes('minecraftforge')) return 'forge';
    if (versionData.inheritsFrom) {
      const parentLower = (versionData.inheritsFrom || '').toLowerCase();
      if (parentLower.includes('fabric')) return 'fabric';
      if (parentLower.includes('quilt')) return 'quilt';
    }
  }

  return 'vanilla';
}

function extractBaseVersion(versionId, versionData = null) {
  if (versionData && versionData.inheritsFrom) {
    return versionData.inheritsFrom;
  }
  
  const fabricMatch = (versionId || '').match(/^fabric-loader-[^-]+-(.+)$/i);
  if (fabricMatch) return fabricMatch[1];

  const quiltMatch = (versionId || '').match(/^quilt-loader-[^-]+-(.+)$/i);
  if (quiltMatch) return quiltMatch[1];

  const forgeMatch = (versionId || '').match(/^([^-]+)-forge/i);
  if (forgeMatch) return forgeMatch[1];

  const neoforgeMatch = (versionId || '').match(/^([^-]+)-neoforge/i);
  if (neoforgeMatch) return neoforgeMatch[1];

  return versionId;
}

module.exports = {
  getFabricGameVersions,
  getFabricLoaders,
  getFabricProfile,
  getQuiltGameVersions,
  getQuiltLoaders,
  getQuiltProfile,
  installLoader,
  detectLoaderType,
  extractBaseVersion
};
