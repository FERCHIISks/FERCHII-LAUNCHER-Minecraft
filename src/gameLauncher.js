const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureJavaRuntime, getRequiredJavaMajorVersion } = require('./javaManager');
const { prepareVersion } = require('./mojang');

function evaluateRules(rules, activeFeatures = {}) {
  if (!rules || !Array.isArray(rules) || rules.length === 0) return true;
  let allow = false;
  for (const r of rules) {
    let matches = true;
    if (r.os) {
      if (r.os.name && r.os.name !== 'windows') matches = false;
    }
    if (r.features) {
      for (const [feat, val] of Object.entries(r.features)) {
        if (activeFeatures[feat] !== val) {
          matches = false;
          break;
        }
      }
    }
    if (matches) {
      allow = (r.action === 'allow');
    }
  }
  return allow;
}

class GameLauncher {
  constructor() {
    this.activeProcess = null;
    this.logBuffer = [];
    this.statusListeners = [];
    this.logListeners = [];
    this.currentStatus = {
      state: 'idle',
      message: 'Listo para jugar',
      progress: 0,
      version: null
    };
  }

  onStatus(callback) {
    this.statusListeners.push(callback);
  }

  onLog(callback) {
    this.logListeners.push(callback);
  }

  emitStatus(state, message, progress = 0, version = null) {
    this.currentStatus = { state, message, progress, version };
    for (const cb of this.statusListeners) {
      cb(this.currentStatus);
    }
  }

  emitLog(line, type = 'info') {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      text: line.trim(),
      type
    };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 1500) {
      this.logBuffer.shift();
    }
    for (const cb of this.logListeners) {
      cb(entry);
    }
  }

  getStatus() {
    return this.currentStatus;
  }

  getLogs() {
    return this.logBuffer;
  }

  clearLogs() {
    this.logBuffer = [];
  }

  async launch(versionId, account, config) {
    if (this.activeProcess) {
      throw new Error('Ya hay una instancia de Minecraft ejecutándose.');
    }

    try {
      this.emitStatus('preparing', `Preparando versión ${versionId}...`, 5, versionId);
      this.emitLog(`[Launcher] Iniciando Minecraft ${versionId} con usuario: "${account.username}" (${account.type.toUpperCase()})`);

      // 1. Preparar archivos de la versión (cliente JAR, librerías, assets y JSON de versión)
      this.emitStatus('downloading_game', `Verificando archivos locales de ${versionId}...`, 10, versionId);

      const { versionData, classpaths, nativesDir } = await prepareVersion(versionId, config.gameDir, (msg, progress) => {
        this.emitStatus('downloading_game', msg, progress, versionId);
        this.emitLog(`[Archivos] ${msg}`);
      });

      // 2. Determinar y asegurar el runtime de Java correcto
      let javaExe = config.javaPath && fs.existsSync(config.javaPath) ? config.javaPath : null;
      let detectedMajor = 21;

      if (!javaExe) {
        const requiredMajor = getRequiredJavaMajorVersion(versionId, versionData);
        detectedMajor = requiredMajor;
        this.emitLog(`[Launcher] Versión de Java requerida por el juego: Java ${requiredMajor}`);
        this.emitStatus('downloading_java', `Comprobando Java ${requiredMajor}...`, 20, versionId);

        javaExe = await ensureJavaRuntime(requiredMajor, (msg, progress) => {
          this.emitStatus('downloading_java', msg, progress || 20, versionId);
          this.emitLog(`[Java] ${msg}`);
        });
      }

      // Convertir a java.exe si se detectó javaw.exe para capturar stdout/stderr en tiempo real
      let consoleJavaExe = javaExe;
      if (javaExe.toLowerCase().endsWith('javaw.exe')) {
        const altJava = javaExe.slice(0, -9) + 'java.exe';
        if (fs.existsSync(altJava)) {
          consoleJavaExe = altJava;
        }
      }

      this.emitLog(`[Java] Utilizando binario: ${consoleJavaExe}`);

      // 3. Ensamblar Classpath
      const validClasspaths = classpaths.filter(p => fs.existsSync(p));
      const classpathString = validClasspaths.join(';');

      // 4. Parámetros de reemplazo
      const assetsDir = path.join(config.gameDir, 'assets');
      const assetIndexId = versionData.assetIndex ? versionData.assetIndex.id : versionId;

      const replacements = {
        '${auth_player_name}': account.username,
        '${version_name}': versionId,
        '${game_directory}': config.gameDir,
        '${assets_root}': assetsDir,
        '${game_assets}': assetsDir,
        '${assets_index_name}': assetIndexId,
        '${auth_uuid}': account.uuid,
        '${auth_access_token}': account.accessToken || '00000000000000000000000000000000',
        '${user_type}': (account.type === 'microsoft' ? 'msa' : 'mojang'),
        '${version_type}': versionData.type || 'release',
        '${user_properties}': '{}',
        '${natives_directory}': nativesDir,
        '${launcher_name}': 'BattlyLauncher',
        '${launcher_version}': '2.0.0',
        '${classpath}': classpathString,
        '${clientid}': '00000000402b5328',
        '${auth_xuid}': '0'
      };

      // 5. Construir Argumentos JVM
      const jvmArgs = [
        `-Xmx${config.ram || 2}G`,
        '-Xms512M',
        `-Djava.library.path=${nativesDir}`
      ];

      // Argumentos JVM personalizados del usuario
      if (config.jvmArgs && config.jvmArgs.trim()) {
        const extraJvm = config.jvmArgs.trim().split(/\s+/);
        jvmArgs.push(...extraJvm);
      }

      let hasCpInJvm = false;

      // Evaluar argumentos JVM especificados en el JSON de la versión
      if (versionData.arguments?.jvm) {
        for (const rawArg of versionData.arguments.jvm) {
          let valList = [];
          if (typeof rawArg === 'string') {
            valList.push(rawArg);
          } else if (rawArg && rawArg.rules && rawArg.value) {
            if (evaluateRules(rawArg.rules)) {
              if (Array.isArray(rawArg.value)) valList.push(...rawArg.value);
              else valList.push(rawArg.value);
            }
          }

          for (let val of valList) {
            if (val === '-cp' || val === '${classpath}') {
              hasCpInJvm = true;
            }
            for (const [k, v] of Object.entries(replacements)) {
              val = val.split(k).join(v);
            }
            jvmArgs.push(val);
          }
        }
      }

      if (!hasCpInJvm) {
        jvmArgs.push('-cp', classpathString);
      }

      // 6. Construir Argumentos del Juego
      const gameArgs = [];
      const activeFeatures = {
        is_demo_user: false,
        has_custom_resolution: false,
        has_quick_plays_support: false,
        is_quick_play_singleplayer: false,
        is_quick_play_multiplayer: false,
        is_quick_play_realms: false
      };

      if (versionData.arguments?.game) {
        // Formato moderno (1.13+)
        for (const rawArg of versionData.arguments.game) {
          let valList = [];
          if (typeof rawArg === 'string') {
            valList.push(rawArg);
          } else if (rawArg && rawArg.rules && rawArg.value) {
            if (evaluateRules(rawArg.rules, activeFeatures)) {
              if (Array.isArray(rawArg.value)) valList.push(...rawArg.value);
              else valList.push(rawArg.value);
            }
          }

          for (let val of valList) {
            for (const [k, v] of Object.entries(replacements)) {
              val = val.split(k).join(v);
            }
            gameArgs.push(val);
          }
        }
      } else if (versionData.minecraftArguments) {
        // Formato legacy (1.12.2 y anteriores)
        let legacy = versionData.minecraftArguments;
        for (const [k, v] of Object.entries(replacements)) {
          legacy = legacy.split(k).join(v);
        }
        gameArgs.push(...legacy.split(/\s+/));
      }

      // Parámetros de pantalla
      if (config.windowWidth && config.windowHeight) {
        gameArgs.push('--width', String(config.windowWidth));
        gameArgs.push('--height', String(config.windowHeight));
      }
      if (config.fullScreen) {
        gameArgs.push('--fullscreen');
      }

      const mainClass = versionData.mainClass || 'net.minecraft.client.main.Main';
      const finalArgs = [...jvmArgs, mainClass, ...gameArgs];

      this.emitStatus('launching', 'Iniciando motor de Minecraft...', 90, versionId);
      this.emitLog(`[Proceso] Ejecutando: ${mainClass}`);

      const child = spawn(consoleJavaExe, finalArgs, {
        cwd: config.gameDir,
        detached: false,
        windowsHide: true
      });

      this.activeProcess = child;
      this.emitStatus('running', `Minecraft ${versionId} en ejecución`, 100, versionId);
      this.emitLog('[Juego] Proceso de Minecraft en ejecución activa.');

      child.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) this.emitLog(line, 'game');
        }
      });

      child.stderr.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) this.emitLog(line, 'error');
        }
      });

      child.on('close', (code) => {
        this.emitLog(`[Juego] Minecraft finalizó con código: ${code}`);
        this.activeProcess = null;
        this.emitStatus('idle', 'Listo para jugar', 0, null);
      });

      child.on('error', (err) => {
        this.emitLog(`[Error] Fallo en el proceso de Java: ${err.message}`, 'error');
        this.activeProcess = null;
        this.emitStatus('idle', 'Error al iniciar el juego', 0, null);
      });

      return true;
    } catch (err) {
      this.activeProcess = null;
      this.emitStatus('idle', `Error: ${err.message}`, 0, null);
      this.emitLog(`[Error] ${err.message}`, 'error');
      throw err;
    }
  }
}

const launcherInstance = new GameLauncher();
module.exports = launcherInstance;
