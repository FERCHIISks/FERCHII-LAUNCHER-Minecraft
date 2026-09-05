const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function getModsList(gameDir) {
  const modsDir = path.join(gameDir, 'mods');
  if (!fs.existsSync(modsDir)) {
    fs.mkdirSync(modsDir, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(modsDir);
  const mods = [];

  for (const file of files) {
    const fullPath = path.join(modsDir, file);
    const stats = fs.statSync(fullPath);

    if (stats.isFile()) {
      const isEnabled = file.endsWith('.jar');
      const isDisabled = file.endsWith('.disabled') || file.endsWith('.jar.disabled');

      if (isEnabled || isDisabled) {
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        mods.push({
          name: file.replace('.jar.disabled', '').replace('.disabled', '').replace('.jar', ''),
          filename: file,
          enabled: isEnabled,
          size: `${sizeMB} MB`,
          modifiedTime: stats.mtime
        });
      }
    }
  }

  return mods;
}

function toggleMod(gameDir, filename, enable) {
  const modsDir = path.join(gameDir, 'mods');
  const currentPath = path.join(modsDir, filename);
  if (!fs.existsSync(currentPath)) {
    throw new Error('Archivo de mod no encontrado');
  }

  let targetName = filename;
  if (enable && filename.endsWith('.disabled')) {
    targetName = filename.replace(/\.disabled$/, '');
  } else if (!enable && filename.endsWith('.jar')) {
    targetName = filename + '.disabled';
  }

  const targetPath = path.join(modsDir, targetName);
  fs.renameSync(currentPath, targetPath);
  return { success: true, newFilename: targetName, enabled: enable };
}

function getResourcePacksList(gameDir) {
  const packsDir = path.join(gameDir, 'resourcepacks');
  if (!fs.existsSync(packsDir)) {
    fs.mkdirSync(packsDir, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(packsDir);
  const packs = [];

  for (const file of files) {
    const fullPath = path.join(packsDir, file);
    const stats = fs.statSync(fullPath);

    let description = 'Paquete de texturas personalizado';
    let iconBase64 = null;

    if (stats.isDirectory()) {
      // Buscar pack.mcmeta y pack.png en carpeta
      const metaPath = path.join(fullPath, 'pack.mcmeta');
      const iconPath = path.join(fullPath, 'pack.png');

      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.pack && meta.pack.description) {
            description = typeof meta.pack.description === 'string' ? meta.pack.description : JSON.stringify(meta.pack.description);
          }
        } catch (e) {}
      }

      if (fs.existsSync(iconPath)) {
        try {
          const iconBuffer = fs.readFileSync(iconPath);
          iconBase64 = 'data:image/png;base64,' + iconBuffer.toString('base64');
        } catch (e) {}
      }

      packs.push({
        name: file,
        filename: file,
        isDirectory: true,
        size: 'Carpeta',
        description,
        icon: iconBase64
      });
    } else if (file.endsWith('.zip')) {
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      packs.push({
        name: file.replace('.zip', ''),
        filename: file,
        isDirectory: false,
        size: `${sizeMB} MB`,
        description,
        icon: null
      });
    }
  }

  return packs;
}

function openFolder(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
  exec(`explorer.exe "${targetPath}"`);
}

module.exports = {
  getModsList,
  toggleMod,
  getResourcePacksList,
  openFolder
};
