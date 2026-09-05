const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

function getDefaultGameDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, '.minecraft');
  }
  return path.join(os.homedir(), '.minecraft');
}

function getTotalSystemRAMGB() {
  const totalBytes = os.totalmem();
  return Math.max(2, Math.round(totalBytes / (1024 * 1024 * 1024)));
}

function getDefaultConfig() {
  const totalRam = getTotalSystemRAMGB();
  const recommendedRam = totalRam >= 16 ? 6 : (totalRam >= 8 ? 4 : 2);
  
  return {
    ram: recommendedRam,
    maxSystemRam: totalRam,
    selectedVersion: '26.2',
    selectedAccountId: null,
    accounts: [], // Sin usuario predeterminado falso
    windowWidth: 1280,
    windowHeight: 720,
    fullScreen: false,
    closeOnLaunch: true,
    gameDir: getDefaultGameDir(),
    javaPath: '',
    jvmArgs: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC',
    // Personalización y Temas
    glassOpacity: 78,
    accentColor: '#00f0ff',
    themePreset: 'cyan',
    bgImage: '',
    bgImageOpacity: 45
  };
}


function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      const defaults = getDefaultConfig();
      const merged = { ...defaults, ...parsed };
      merged.maxSystemRam = getTotalSystemRAMGB();
      // Eliminar cualquier cuenta residual que se llame Player
      if (merged.accounts) {
        merged.accounts = merged.accounts.filter(a => a.username !== 'Player' && a.id !== 'default_offline');
        if (!merged.accounts.some(a => a.id === merged.selectedAccountId)) {
          merged.selectedAccountId = merged.accounts.length > 0 ? merged.accounts[0].id : null;
        }
      }
      // Asegurar que la ruta del juego sea dinámica para cada usuario
      if (!merged.gameDir || merged.gameDir.includes('\\FERCHII\\')) {
        merged.gameDir = getDefaultGameDir();
      }
      return merged;
    }
  } catch (err) {
    console.error('[Config] Error cargando config, usando defaults:', err.message);
  }
  const config = getDefaultConfig();
  saveConfig(config);
  return config;
}

function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Config] Error guardando config:', err.message);
    return false;
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  getDefaultConfig,
  getTotalSystemRAMGB,
  getDefaultGameDir
};
