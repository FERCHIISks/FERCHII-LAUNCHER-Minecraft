// --- Estado Global del Launcher ---
let launcherConfig = null;
let allVersions = []
let localVersions = [];
let activeFilter = 'all';
let msPollingInterval = null;
let activeModsTab = 'mods';

// --- Inicialización al Cargar el DOM ---
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Splash screen primero
  showSplash();

  setupWindowControls();
  setupNavigation();
  setupAccountHandlers();
  setupSettingsHandlers();
  setupCustomizationHandlers();
  setupModsHandlers();
  setupVersionsHandlers();
  setupInstallLoaderHandlers();
  setupProfileHandlers();
  setupPlayHandler();
  setupUpdateHandlers();
  setupSSE();

  await loadInitialConfig();
  await loadVersionsList();
  await loadModsList();
  await loadProfilesList();

  // 2. Particulas pixeladas en fondo
  initPixelParticles();

  // 3. Noticias Mojang en el home
  loadMojangNews();

  // 4. Ocultar splash cuando todo cargo
  hideSplash();
});


// --- Controles de Ventana Nativa Estilo macOS ---
function setupWindowControls() {
  const btnMin = document.getElementById('btnWinMinimize');
  const btnMax = document.getElementById('btnWinMaximize');
  const btnClose = document.getElementById('btnWinClose');

  if (btnMin) {
    btnMin.addEventListener('click', () => {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage('minimize');
      }
    });
  }

  if (btnMax) {
    btnMax.addEventListener('click', () => {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage('maximize');
      }
    });
  }

  if (btnClose) {
    btnClose.addEventListener('click', () => {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage('close');
      } else {
        window.close();
      }
    });
  }

  // Arrastre nativo fluido
  const dragRegions = document.querySelectorAll('.window-drag');
  dragRegions.forEach(region => {
    region.addEventListener('mousedown', (e) => {
      if (e.target.closest('.no-drag') || e.target.closest('button') || e.target.closest('input')) return;
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage('drag');
      }
    });
  });
}

// --- Navegación entre Vistas ---
function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-item');
  const viewPanels = document.querySelectorAll('.view-panel');
  const viewTitle = document.getElementById('viewTitle');
  const viewSubtitle = document.getElementById('viewSubtitle');

  const titles = {
    home: { title: 'Inicio', subtitle: 'FERCHII LAUNCHER' },
    versions: { title: 'Gestor de Versiones', subtitle: 'Catálogo de Mojang y Versiones Locales' },
    mods: { title: 'Mods y Texturas', subtitle: 'Gestión de Addons y Resource Packs' },
    settings: { title: 'Configuración del Lanzador', subtitle: 'Rendimiento, Temas y Memoria' },
    logs: { title: 'Consola de Diagnóstico', subtitle: 'Registro en tiempo real del juego' }
  };

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetView = btn.getAttribute('data-view');

      navButtons.forEach(b => b.classList.remove('active'));
      viewPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const panel = document.getElementById(`view-${targetView}`);
      if (panel) panel.classList.add('active');

      if (titles[targetView]) {
        viewTitle.textContent = titles[targetView].title;
        viewSubtitle.textContent = titles[targetView].subtitle;
      }

      if (targetView === 'versions') {
        loadVersionsList();
      }

      if (targetView === 'mods') {
        if (launcherConfig) {
          const localVer = localVersions.find(v => v.id === launcherConfig.selectedVersion);
          updateModStatusBanner(getLoaderInfo(launcherConfig.selectedVersion, localVer));
        }
        if (activeModsTab === 'mods') loadModsList();
        else loadResourcePacksList();
      }
    });
  });
}


// --- Carga de Configuración ---
async function loadInitialConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.success) {
      launcherConfig = data.config;
      updateUIFromConfig(data.totalSystemRam);
      applyCustomizationSettings();
    }
  } catch (err) {
    console.error('Error cargando configuración:', err);
  }
}

function updateUIFromConfig(totalSystemRam) {
  if (!launcherConfig) return;

  // RAM Slider
  const maxRam = totalSystemRam || launcherConfig.maxSystemRam || 16;
  const ramSlider = document.getElementById('ramSlider');
  const ramValueBadge = document.getElementById('ramValueBadge');
  const ramMaxMarker = document.getElementById('ramMaxMarker');
  const sidebarRamLabel = document.getElementById('sidebarRamLabel');
  const homeStatRam = document.getElementById('homeStatRam');

  ramSlider.max = maxRam;
  ramSlider.value = launcherConfig.ram || 2;
  ramValueBadge.textContent = `${ramSlider.value} GB`;
  ramMaxMarker.textContent = `${maxRam} GB (Total PC)`;
  sidebarRamLabel.textContent = `RAM: ${ramSlider.value} GB asignados`;
  homeStatRam.textContent = `${ramSlider.value} GB`;

  // Resolución y pantalla
  document.getElementById('windowWidthInput').value = launcherConfig.windowWidth || 1280;
  document.getElementById('windowHeightInput').value = launcherConfig.windowHeight || 720;
  document.getElementById('fullScreenToggle').checked = !!launcherConfig.fullScreen;
  const closeOnLaunchToggle = document.getElementById('closeOnLaunchToggle');
  if (closeOnLaunchToggle) {
    closeOnLaunchToggle.checked = launcherConfig.closeOnLaunch !== false;
  }

  // Java & Directorio
  document.getElementById('customJavaInput').value = launcherConfig.javaPath || '';
  document.getElementById('jvmArgsInput').value = launcherConfig.jvmArgs || '';
  document.getElementById('gameDirInput').value = launcherConfig.gameDir || '';

  // Versión seleccionada
  document.getElementById('currentVersionName').textContent = launcherConfig.selectedVersion;
  document.getElementById('homeDisplayVersion').textContent = `Minecraft ${launcherConfig.selectedVersion}`;

  // Actualizar cuenta activa
  updateAccountUI();
}

// --- Personalización de Temas, Opacidad y Fondo ---
function applyCustomizationSettings() {
  if (!launcherConfig) return;

  const root = document.documentElement;

  // 1. Opacidad Glass
  const glassOp = launcherConfig.glassOpacity !== undefined ? launcherConfig.glassOpacity : 78;
  root.style.setProperty('--glass-opacity-val', String(glassOp / 100));
  const opSlider = document.getElementById('glassOpacitySlider');
  const opBadge = document.getElementById('glassOpacityBadge');
  if (opSlider) opSlider.value = glassOp;
  if (opBadge) opBadge.textContent = `${glassOp}%`;

  // 2. Color de Acento y Tema
  const accent = launcherConfig.accentColor || '#00f0ff';
  root.style.setProperty('--accent-cyan', accent);

  const customAccentPicker = document.getElementById('customAccentPicker');
  const customColorHexText = document.getElementById('customColorHexText');
  if (customAccentPicker) customAccentPicker.value = accent;
  if (customColorHexText) customColorHexText.textContent = accent.toUpperCase();

  const themeBtns = document.querySelectorAll('.theme-preset-btn');
  themeBtns.forEach(btn => {
    if (btn.getAttribute('data-color') === accent || btn.getAttribute('data-preset') === launcherConfig.themePreset) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // 3. Imagen de Fondo y Opacidad
  const bgOverlay = document.getElementById('customBgOverlay');
  const bgInput = document.getElementById('bgImageInput');
  const bgOpSlider = document.getElementById('bgOpacitySlider');
  const bgOpBadge = document.getElementById('bgOpacityBadge');

  if (bgInput) bgInput.value = launcherConfig.bgImage || '';
  const bgOp = launcherConfig.bgImageOpacity !== undefined ? launcherConfig.bgImageOpacity : 45;
  if (bgOpSlider) bgOpSlider.value = bgOp;
  if (bgOpBadge) bgOpBadge.textContent = `${bgOp}%`;

  if (bgOverlay) {
    if (launcherConfig.bgImage && launcherConfig.bgImage.trim()) {
      bgOverlay.style.backgroundImage = `url("${launcherConfig.bgImage.trim()}")`;
      bgOverlay.style.opacity = String(bgOp / 100);
    } else {
      bgOverlay.style.backgroundImage = 'none';
    }
  }
}

function setupCustomizationHandlers() {
  const root = document.documentElement;
  const glassSlider = document.getElementById('glassOpacitySlider');
  const glassBadge = document.getElementById('glassOpacityBadge');
  const themeBtns = document.querySelectorAll('.theme-preset-btn');
  const bgInput = document.getElementById('bgImageInput');
  const bgSlider = document.getElementById('bgOpacitySlider');
  const bgBadge = document.getElementById('bgOpacityBadge');
  const bgOverlay = document.getElementById('customBgOverlay');
  const customAccentPicker = document.getElementById('customAccentPicker');
  const customColorHexText = document.getElementById('customColorHexText');

  // Control en tiempo real de opacidad glass
  if (glassSlider) {
    glassSlider.addEventListener('input', () => {
      const val = glassSlider.value;
      glassBadge.textContent = `${val}%`;
      root.style.setProperty('--glass-opacity-val', String(val / 100));
    });
  }

  // Selector de temas profesionales
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      themeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const color = btn.getAttribute('data-color');
      root.style.setProperty('--accent-cyan', color);
      if (customAccentPicker) customAccentPicker.value = color;
      if (customColorHexText) customColorHexText.textContent = color.toUpperCase();
    });
  });

  // Selector de color libre en tiempo real
  if (customAccentPicker) {
    customAccentPicker.addEventListener('input', () => {
      const color = customAccentPicker.value;
      root.style.setProperty('--accent-cyan', color);
      if (customColorHexText) customColorHexText.textContent = color.toUpperCase();
      themeBtns.forEach(b => b.classList.remove('active'));
    });
  }

  // Control en tiempo real de fondo personalizado
  if (bgInput) {
    bgInput.addEventListener('input', () => {
      const url = bgInput.value.trim();
      if (url) {
        bgOverlay.style.backgroundImage = `url("${url}")`;
      } else {
        bgOverlay.style.backgroundImage = 'none';
      }
    });
  }

  if (bgSlider) {
    bgSlider.addEventListener('input', () => {
      const val = bgSlider.value;
      bgBadge.textContent = `${val}%`;
      bgOverlay.style.opacity = String(val / 100);
    });
  }
}

// --- Gestión de Cuentas (Sin Cuentas Falsas Predefinidas) ---
function setupAccountHandlers() {
  const accountBtn = document.getElementById('accountSelectorBtn');
  const accountDropdown = document.getElementById('accountDropdown');
  const btnAddOffline = document.getElementById('btnAddOffline');
  const btnAddMicrosoft = document.getElementById('btnAddMicrosoft');

  const modalOffline = document.getElementById('modalOffline');
  const btnCloseOfflineModal = document.getElementById('btnCloseOfflineModal');
  const btnCancelOffline = document.getElementById('btnCancelOffline');
  const btnSubmitOffline = document.getElementById('btnSubmitOffline');
  const offlineInput = document.getElementById('offlineUsernameInput');
  const offlineAvatarPreview = document.getElementById('offlineAvatarPreview');

  const modalMicrosoft = document.getElementById('modalMicrosoft');
  const btnCloseMsModal = document.getElementById('btnCloseMsModal');
  const btnCancelMs = document.getElementById('btnCancelMs');
  const btnStartMsAuth = document.getElementById('btnStartMsAuth');
  const btnCopyMsCode = document.getElementById('btnCopyMsCode');

  accountBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    accountDropdown.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    if (!accountDropdown.contains(e.target) && !accountBtn.contains(e.target)) {
      accountDropdown.classList.remove('show');
    }
  });

  btnAddOffline.addEventListener('click', () => {
    accountDropdown.classList.remove('show');
    modalOffline.classList.add('active');
    offlineInput.focus();
  });

  btnCloseOfflineModal.addEventListener('click', () => modalOffline.classList.remove('active'));
  btnCancelOffline.addEventListener('click', () => modalOffline.classList.remove('active'));

  let debounceTimer;
  offlineInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const raw = offlineInput.value;
      const clean = raw.trim().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
      const hint = document.getElementById('offlineUsernameHint');

      if (!clean) {
        // Sin caracteres validos
        offlineAvatarPreview.src = 'https://mc-heads.net/avatar/MHF_Steve/80';
        if (raw.trim().length > 0) {
          hint.style.display = 'block';
          hint.style.color = '#ff6b6b';
          hint.textContent = 'El nombre no tiene caracteres validos (solo letras, numeros y _).';
          btnSubmitOffline.disabled = true;
        } else {
          hint.style.display = 'none';
          btnSubmitOffline.disabled = false;
        }
      } else if (clean !== raw.trim()) {
        // El nombre tiene caracteres que se eliminaran
        hint.style.display = 'block';
        hint.style.color = '#f0a500';
        hint.textContent = `Se guardara como: "${clean}" (los espacios y simbolos se eliminan automaticamente).`;
        offlineAvatarPreview.src = `https://mc-heads.net/avatar/${encodeURIComponent(clean)}/80`;
        btnSubmitOffline.disabled = clean.length < 3;
      } else {
        hint.style.display = 'none';
        offlineAvatarPreview.src = `https://mc-heads.net/avatar/${encodeURIComponent(clean)}/80`;
        btnSubmitOffline.disabled = false;
      }
    }, 300);
  });

  btnSubmitOffline.addEventListener('click', async () => {
    const name = offlineInput.value.trim();
    if (!name) return;

    const hint = document.getElementById('offlineUsernameHint');
    btnSubmitOffline.disabled = true;
    btnSubmitOffline.textContent = 'Guardando...';

    try {
      const res = await fetch('/api/accounts/offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name })
      });
      const data = await res.json();
      if (data.success) {
        launcherConfig = data.config;
        updateAccountUI();
        modalOffline.classList.remove('active');
        offlineInput.value = '';
        if (hint) hint.style.display = 'none';
      } else {
        // Mostrar el error del servidor bajo el input
        if (hint) {
          hint.style.display = 'block';
          hint.style.color = '#ff6b6b';
          hint.textContent = data.message || 'Error al guardar la cuenta.';
        }
      }
    } catch (e) {
      if (hint) {
        hint.style.display = 'block';
        hint.style.color = '#ff6b6b';
        hint.textContent = 'Error de red: ' + e.message;
      }
    } finally {
      btnSubmitOffline.disabled = false;
      btnSubmitOffline.textContent = 'Guardar y Usar';
    }
  });

  btnAddMicrosoft.addEventListener('click', () => {
    accountDropdown.classList.remove('show');
    modalMicrosoft.classList.add('active');
    document.getElementById('msStepInitial').style.display = 'block';
    document.getElementById('msStepPending').style.display = 'none';
  });

  btnCloseMsModal.addEventListener('click', () => closeMsModal());
  btnCancelMs.addEventListener('click', () => closeMsModal());

  function closeMsModal() {
    modalMicrosoft.classList.remove('active');
    if (msPollingInterval) {
      clearInterval(msPollingInterval);
      msPollingInterval = null;
    }
  }

  btnStartMsAuth.addEventListener('click', async () => {
    try {
      btnStartMsAuth.disabled = true;
      btnStartMsAuth.textContent = 'Solicitando código a Microsoft...';

      const res = await fetch('/api/accounts/microsoft/device-code', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        document.getElementById('msStepInitial').style.display = 'none';
        document.getElementById('msStepPending').style.display = 'block';
        document.getElementById('msUserCode').textContent = data.userCode;

        // Copiar el código automáticamente al portapapeles
        try {
          await navigator.clipboard.writeText(data.userCode);
          btnCopyMsCode.textContent = 'Copiado ✓';
          setTimeout(() => btnCopyMsCode.textContent = 'Copiar', 3000);
        } catch (e) {}

        btnCopyMsCode.onclick = () => {
          navigator.clipboard.writeText(data.userCode);
          btnCopyMsCode.textContent = 'Copiado ✓';
          setTimeout(() => btnCopyMsCode.textContent = 'Copiar', 2000);
        };

        // Configurar el botón de enlace para abrir en navegador del sistema
        const verifyUrl = data.verificationUrl || 'https://microsoft.com/link';
        const msLinkBtn = document.getElementById('msLinkBtn');
        if (msLinkBtn) {
          msLinkBtn.href = verifyUrl;
          msLinkBtn.onclick = (e) => {
            e.preventDefault();
            if (window.chrome && window.chrome.webview) {
              window.chrome.webview.postMessage('openUrl:' + verifyUrl);
            } else {
              window.open(verifyUrl, '_blank');
            }
          };
        }

        // Abrir el navegador automáticamente al mostrar el código
        setTimeout(() => {
          if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage('openUrl:' + verifyUrl);
          }
        }, 600);

        if (msPollingInterval) clearInterval(msPollingInterval);
        msPollingInterval = setInterval(async () => {
          try {
            const pollRes = await fetch('/api/accounts/microsoft/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceCode: data.deviceCode })
            });
            const pollData = await pollRes.json();

            if (pollData.status === 'complete') {
              clearInterval(msPollingInterval);
              msPollingInterval = null;
              await loadInitialConfig();
              closeMsModal();
            } else if (pollData.status === 'error' || pollData.status === 'expired_token') {
              clearInterval(msPollingInterval);
              msPollingInterval = null;
              alert('Error en vinculación: ' + (pollData.message || 'Código expirado'));
              closeMsModal();
            }
          } catch (err) {}
        }, 5000);
      }
    } catch (e) {
      alert('Error iniciando Microsoft OAuth: ' + e.message);
    } finally {
      btnStartMsAuth.disabled = false;
      btnStartMsAuth.textContent = 'Iniciar Autorización con Microsoft';
    }
  });
}

function updateAccountUI() {
  const topAvatarImg = document.getElementById('topAvatarImg');
  const topUsername = document.getElementById('topUsername');
  const topAccountBadge = document.getElementById('topAccountBadge');
  const homeStatMode = document.getElementById('homeStatMode');

  if (!launcherConfig || !launcherConfig.accounts || launcherConfig.accounts.length === 0) {
    topUsername.textContent = 'Sin Cuenta';
    topAvatarImg.src = 'https://mc-heads.net/avatar/MHF_Steve/40';
    topAccountBadge.textContent = 'NO INICIADO';
    topAccountBadge.className = 'account-type-badge offline';
    homeStatMode.textContent = 'Sin Cuenta';
    const homeStatPlayTime = document.getElementById('homeStatPlayTime');
    if (homeStatPlayTime) homeStatPlayTime.textContent = '0h 0m';

    const list = document.getElementById('dropdownAccountsList');
    list.innerHTML = '<div style="padding: 10px; font-size: 11px; color: var(--text-dim); text-align: center;">No hay cuentas agregadas.<br>Haz clic abajo para crear una.</div>';
    return;
  }

  const currentAcc = launcherConfig.accounts.find(a => a.id === launcherConfig.selectedAccountId) || launcherConfig.accounts[0];
  topUsername.textContent = currentAcc.username;
  topAvatarImg.src = currentAcc.avatarUrl || `https://mc-heads.net/avatar/${currentAcc.username}/40`;

  if (currentAcc.type === 'microsoft') {
    topAccountBadge.textContent = 'PREMIUM';
    topAccountBadge.className = 'account-type-badge microsoft';
    homeStatMode.textContent = 'Premium (MS)';
  } else {
    topAccountBadge.textContent = 'OFFLINE';
    topAccountBadge.className = 'account-type-badge offline';
    homeStatMode.textContent = 'No-Premium';
  }

  const homeStatPlayTime = document.getElementById('homeStatPlayTime');
  if (homeStatPlayTime) {
    const totalSec = currentAcc.playTimeSeconds || 0;
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    homeStatPlayTime.textContent = totalSec < 60 ? `${totalSec}s` : `${hours}h ${mins}m`;
  }

  const list = document.getElementById('dropdownAccountsList');
  list.innerHTML = '';

  launcherConfig.accounts.forEach(acc => {
    const isSelected = acc.id === currentAcc.id;
    const item = document.createElement('button');
    item.className = `account-item-btn ${isSelected ? 'selected' : ''}`;
    item.innerHTML = `
      <div class="acc-item-left">
        <img class="acc-item-avatar" src="${acc.avatarUrl || `https://mc-heads.net/avatar/${acc.username}/24`}" alt="Avatar">
        <div class="acc-item-info">
          <span class="acc-item-name">${acc.username}</span>
          <span class="acc-item-type">${acc.type === 'microsoft' ? 'Microsoft' : 'Offline'}</span>
        </div>
      </div>
      ${isSelected ? `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" style="color: var(--accent-cyan);">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ` : ''}
    `;

    item.addEventListener('click', async () => {
      if (isSelected) return;
      try {
        const res = await fetch('/api/accounts/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: acc.id })
        });
        const data = await res.json();
        if (data.success) {
          launcherConfig.selectedAccountId = acc.id;
          updateAccountUI();
          document.getElementById('accountDropdown').classList.remove('show');
        }
      } catch (err) {}
    });

    list.appendChild(item);
  });
}

// --- Ajustes ---
function setupSettingsHandlers() {
  const ramSlider = document.getElementById('ramSlider');
  const ramValueBadge = document.getElementById('ramValueBadge');
  const sidebarRamLabel = document.getElementById('sidebarRamLabel');
  const homeStatRam = document.getElementById('homeStatRam');
  const presetBtns = document.querySelectorAll('.preset-btn');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const saveStatusMsg = document.getElementById('saveStatusMsg');

  ramSlider.addEventListener('input', () => {
    const val = ramSlider.value;
    ramValueBadge.textContent = `${val} GB`;
    sidebarRamLabel.textContent = `RAM: ${val} GB asignados`;
    homeStatRam.textContent = `${val} GB`;
  });

  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const ram = parseInt(btn.getAttribute('data-ram'), 10);
      if (ram <= parseInt(ramSlider.max, 10)) {
        ramSlider.value = ram;
        ramValueBadge.textContent = `${ram} GB`;
        sidebarRamLabel.textContent = `RAM: ${ram} GB asignados`;
        homeStatRam.textContent = `${ram} GB`;
      }
    });
  });

  btnSaveSettings.addEventListener('click', async () => {
    const activeThemeBtn = document.querySelector('.theme-preset-btn.active');
    const updated = {
      ram: parseInt(ramSlider.value, 10),
      windowWidth: parseInt(document.getElementById('windowWidthInput').value, 10) || 1280,
      windowHeight: parseInt(document.getElementById('windowHeightInput').value, 10) || 720,
      fullScreen: document.getElementById('fullScreenToggle').checked,
      closeOnLaunch: document.getElementById('closeOnLaunchToggle') ? document.getElementById('closeOnLaunchToggle').checked : true,
      javaPath: document.getElementById('customJavaInput').value.trim(),
      jvmArgs: document.getElementById('jvmArgsInput').value.trim(),
      // Personalización
      glassOpacity: parseInt(document.getElementById('glassOpacitySlider').value, 10),
      accentColor: (document.getElementById('customAccentPicker') && document.getElementById('customAccentPicker').value) || (activeThemeBtn ? activeThemeBtn.getAttribute('data-color') : '#00f0ff'),
      themePreset: activeThemeBtn ? activeThemeBtn.getAttribute('data-preset') : 'custom',
      bgImage: document.getElementById('bgImageInput').value.trim(),
      bgImageOpacity: parseInt(document.getElementById('bgOpacitySlider').value, 10)
    };

    try {
      btnSaveSettings.disabled = true;
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      const data = await res.json();
      if (data.success) {
        launcherConfig = data.config;
        saveStatusMsg.textContent = 'Configuración guardada con éxito.';
        setTimeout(() => saveStatusMsg.textContent = '', 3000);
      }
    } catch (e) {
      alert('Error guardando configuración: ' + e.message);
    } finally {
      btnSaveSettings.disabled = false;
    }
  });

  // Limpiar y copiar logs
  document.getElementById('btnClearLogs').addEventListener('click', async () => {
    await fetch('/api/logs/clear', { method: 'POST' });
    document.getElementById('terminalOutput').innerHTML = '<div class="log-line info">[Sistema] Consola reiniciada.</div>';
  });

  document.getElementById('btnCopyLogs').addEventListener('click', () => {
    const text = document.getElementById('terminalOutput').innerText;
    navigator.clipboard.writeText(text);
    const btn = document.getElementById('btnCopyLogs');
    btn.textContent = 'Copiado';
    setTimeout(() => btn.textContent = 'Copiar', 2000);
  });
}

// --- Mods y Paquetes de Recursos ---
function setupModsHandlers() {
  const tabMods = document.getElementById('tabMods');
  const tabRP = document.getElementById('tabResourcepacks');
  const modsContainer = document.getElementById('modsListContainer');
  const rpContainer = document.getElementById('resourcepacksListContainer');
  const openFolderLabel = document.getElementById('openFolderLabel');
  const btnOpenFolder = document.getElementById('btnOpenModsFolder');
  const btnRefresh = document.getElementById('btnRefreshMods');

  tabMods.addEventListener('click', () => {
    tabMods.classList.add('active');
    tabRP.classList.remove('active');
    modsContainer.style.display = 'grid';
    rpContainer.style.display = 'none';
    openFolderLabel.textContent = 'Abrir Carpeta de Mods';
    activeModsTab = 'mods';
    loadModsList();
  });

  tabRP.addEventListener('click', () => {
    tabRP.classList.add('active');
    tabMods.classList.remove('active');
    modsContainer.style.display = 'none';
    rpContainer.style.display = 'grid';
    openFolderLabel.textContent = 'Abrir Carpeta de Texturas';
    activeModsTab = 'resourcepacks';
    loadResourcePacksList();
  });

  btnOpenFolder.addEventListener('click', async () => {
    const endpoint = activeModsTab === 'mods' ? '/api/mods/open-folder' : '/api/resourcepacks/open-folder';
    await fetch(endpoint, { method: 'POST' });
  });

  btnRefresh.addEventListener('click', () => {
    if (activeModsTab === 'mods') loadModsList();
    else loadResourcePacksList();
  });
}

async function loadModsList() {
  const container = document.getElementById('modsListContainer');
  try {
    const res = await fetch('/api/mods');
    const data = await res.json();
    if (!data.success || !data.mods || data.mods.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-dim);">
          <p style="font-weight: 700; font-size: 15px; color: var(--text-muted); margin-bottom: 8px;">No hay mods instalados</p>
          <p style="font-size: 13px;">Haz clic en "Abrir Carpeta de Mods" y arrastra tus archivos <b>.jar</b> allí.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    data.mods.forEach(mod => {
      const card = document.createElement('div');
      card.className = 'mod-card';
      card.innerHTML = `
        <div class="mod-info-group">
          <span class="mod-title">${mod.name}</span>
          <span class="mod-meta">${mod.size} &bull; ${mod.enabled ? 'Activo' : 'Desactivado'}</span>
        </div>
        <label class="switch">
          <input type="checkbox" class="mod-toggle" data-filename="${mod.filename}" ${mod.enabled ? 'checked' : ''}>
          <span class="slider round"></span>
        </label>
      `;

      card.querySelector('.mod-toggle').addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        await fetch('/api/mods/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: mod.filename, enable: isChecked })
        });
        loadModsList();
      });

      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = '<div class="loading-spinner">Error al cargar la lista de mods.</div>';
  }
}

async function loadResourcePacksList() {
  const container = document.getElementById('resourcepacksListContainer');
  try {
    const res = await fetch('/api/resourcepacks');
    const data = await res.json();
    if (!data.success || !data.packs || data.packs.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-dim);">
          <p style="font-weight: 700; font-size: 15px; color: var(--text-muted); margin-bottom: 8px;">No hay paquetes de texturas</p>
          <p style="font-size: 13px;">Haz clic en "Abrir Carpeta de Texturas" y añade archivos <b>.zip</b> o carpetas de texturas.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    data.packs.forEach(pack => {
      const card = document.createElement('div');
      card.className = 'rp-card';
      card.innerHTML = `
        <img class="rp-icon" src="${pack.icon || 'https://mc-heads.net/avatar/MHF_Chest/50'}" alt="Icon">
        <div class="rp-info">
          <span class="rp-name">${pack.name}</span>
          <span class="rp-desc">${pack.description || 'Paquete de recursos'}</span>
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = '<div class="loading-spinner">Error al cargar paquetes de texturas.</div>';
  }
}

// --- Mod Loaders y Versiones ---
function getLoaderInfo(versionId, versionObj = null) {
  const vId = (versionId || '').toLowerCase();

  if (versionObj && versionObj.loader) {
    return {
      type: versionObj.loader,
      label: formatLoaderLabel(versionObj.loader),
      badgeClass: versionObj.loader,
      baseVersion: versionObj.baseVersion || versionId
    };
  }

  if (vId.includes('fabric')) return { type: 'fabric', label: 'Fabric Loader', badgeClass: 'fabric', baseVersion: extractCleanBase(versionId) };
  if (vId.includes('quilt')) return { type: 'quilt', label: 'Quilt Loader', badgeClass: 'quilt', baseVersion: extractCleanBase(versionId) };
  if (vId.includes('neoforge')) return { type: 'neoforge', label: 'NeoForge', badgeClass: 'neoforge', baseVersion: extractCleanBase(versionId) };
  if (vId.includes('forge')) return { type: 'forge', label: 'Forge', badgeClass: 'forge', baseVersion: extractCleanBase(versionId) };
  if (vId.includes('optifine')) return { type: 'optifine', label: 'OptiFine', badgeClass: 'optifine', baseVersion: extractCleanBase(versionId) };

  return { type: 'vanilla', label: 'Vanilla Oficial', badgeClass: 'vanilla', baseVersion: versionId };
}

function extractCleanBase(vId) {
  const f = (vId || '').match(/^fabric-loader-[^-]+-(.+)$/i);
  if (f) return f[1];
  const q = (vId || '').match(/^quilt-loader-[^-]+-(.+)$/i);
  if (q) return q[1];
  const forge = (vId || '').match(/^([^-]+)-forge/i);
  if (forge) return forge[1];
  const neoforge = (vId || '').match(/^([^-]+)-neoforge/i);
  if (neoforge) return neoforge[1];
  return vId;
}

function formatLoaderLabel(type) {
  switch (type) {
    case 'fabric': return 'Fabric';
    case 'quilt': return 'Quilt';
    case 'forge': return 'Forge';
    case 'neoforge': return 'NeoForge';
    case 'optifine': return 'OptiFine';
    default: return 'Vanilla';
  }
}

async function loadVersionsList() {
  try {
    const res = await fetch('/api/versions');
    const data = await res.json();
    if (data.success) {
      allVersions = data.versions || [];
      localVersions = data.localVersions || [];
      renderVersionsGrid();
      updateSelectedVersionDisplay();
    }
  } catch (e) {
    console.error('Error al cargar versiones:', e);
  }
}

function setupVersionsHandlers() {
  const searchInput = document.getElementById('versionSearchInput');
  const filterTabs = document.querySelectorAll('.filter-tab');

  searchInput.addEventListener('input', () => {
    renderVersionsGrid();
  });

  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.getAttribute('data-filter');
      renderVersionsGrid();
    });
  });

  document.getElementById('versionSelectorBtn').addEventListener('click', () => {
    const btnVer = document.querySelector('.nav-item[data-view="versions"]');
    if (btnVer) btnVer.click();
  });
}

function renderVersionsGrid() {
  const grid = document.getElementById('versionsGrid');
  const search = document.getElementById('versionSearchInput').value.toLowerCase().trim();
  grid.innerHTML = '';

  const localMap = new Map(localVersions.map(v => [v.id, v]));

  // Combinar versiones locales y remotas
  let combined = [];

  // 1. Añadir locales primero
  localVersions.forEach(lv => {
    combined.push({
      ...lv,
      isLocal: true,
      loader: lv.loader || getLoaderInfo(lv.id, lv).type,
      type: lv.type || 'instalada'
    });
  });

  // 2. Añadir remotas de Mojang
  allVersions.forEach(rv => {
    if (!localMap.has(rv.id)) {
      combined.push({
        ...rv,
        isLocal: false,
        loader: rv.loader || 'vanilla'
      });
    }
  });

  const filtered = combined.filter(v => {
    const loaderInfo = getLoaderInfo(v.id, v);
    const matchesSearch = !search || 
      v.id.toLowerCase().includes(search) || 
      loaderInfo.label.toLowerCase().includes(search) ||
      (v.baseVersion && v.baseVersion.toLowerCase().includes(search));

    if (!matchesSearch) return false;

    if (activeFilter === 'installed') return v.isLocal;
    if (activeFilter === 'fabric') return loaderInfo.type === 'fabric';
    if (activeFilter === 'vanilla') return loaderInfo.type === 'vanilla';
    if (activeFilter === 'quilt') return loaderInfo.type === 'quilt';
    if (activeFilter === 'forge') return loaderInfo.type === 'forge' || loaderInfo.type === 'neoforge';
    if (activeFilter === 'release') return v.type === 'release';
    if (activeFilter === 'snapshot') return v.type === 'snapshot';
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-dim);">
        <p style="font-weight: 700; font-size: 15px; color: var(--text-muted); margin-bottom: 8px;">No se encontraron versiones</p>
        <p style="font-size: 13px;">Prueba a cambiar el filtro o usa el botón <b>"Instalar Cargador"</b> para añadir Fabric o Quilt.</p>
      </div>
    `;
    return;
  }

  const toDisplay = filtered.slice(0, 60);

  toDisplay.forEach(v => {
    const loaderInfo = getLoaderInfo(v.id, v);
    const isSelected = launcherConfig && launcherConfig.selectedVersion === v.id;

    const card = document.createElement('div');
    card.className = `version-card ${isSelected ? 'is-active' : ''}`;
    card.innerHTML = `
      <div class="vc-header">
        <div class="vc-title-group">
          <div class="v-name-row">
            <span class="vc-version-num">${v.id}</span>
          </div>
          <span class="vc-release-type">${v.baseVersion && v.baseVersion !== v.id ? `Minecraft ${v.baseVersion} &bull; ` : ''}${v.type || 'Release'}</span>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <span class="vc-badge ${loaderInfo.badgeClass}">${loaderInfo.label}</span>
          <span class="vc-badge ${v.isLocal ? 'local' : 'remote'}">
            ${v.isLocal ? 'Instalado' : 'Disponible'}
          </span>
        </div>
      </div>
      <div class="vc-footer">
        <span class="vc-date">${v.releaseTime ? v.releaseTime.split('T')[0] : (v.isLocal ? 'Local' : 'Oficial')}</span>
        <button class="vc-btn-select ${isSelected ? 'selected' : ''}">
          ${isSelected ? 'Seleccionada' : 'Seleccionar'}
        </button>
      </div>
    `;

    card.querySelector('.vc-btn-select').addEventListener('click', async (e) => {
      e.stopPropagation();
      await selectVersion(v.id, v.type);
    });

    card.addEventListener('click', async () => {
      await selectVersion(v.id, v.type);
    });

    grid.appendChild(card);
  });
}

async function selectVersion(versionId, versionType) {
  if (!launcherConfig) return;
  launcherConfig.selectedVersion = versionId;

  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedVersion: versionId })
  });

  updateSelectedVersionDisplay();
  renderVersionsGrid();
}

function updateSelectedVersionDisplay() {
  if (!launcherConfig) return;
  const vId = launcherConfig.selectedVersion;
  const localVer = localVersions.find(v => v.id === vId);
  const isLocal = !!localVer;
  const loaderInfo = getLoaderInfo(vId, localVer);

  document.getElementById('currentVersionName').textContent = vId;
  document.getElementById('homeDisplayVersion').textContent = `Minecraft ${loaderInfo.baseVersion || vId}`;

  // Actualizar badges del cargador en Home
  const homeLoaderBadge = document.getElementById('homeLoaderBadge');
  if (homeLoaderBadge) {
    homeLoaderBadge.textContent = loaderInfo.label;
    homeLoaderBadge.className = `hero-tag-badge loader-badge ${loaderInfo.badgeClass}`;
  }

  const currentVersionLoaderPill = document.getElementById('currentVersionLoaderPill');
  if (currentVersionLoaderPill) {
    currentVersionLoaderPill.textContent = loaderInfo.label;
    currentVersionLoaderPill.className = `v-loader-pill ${loaderInfo.badgeClass}`;
  }

  const currentVersionType = document.getElementById('currentVersionType');
  if (currentVersionType) {
    currentVersionType.textContent = isLocal ? 'Instalada en Disco Local' : 'Descarga Automática';
  }

  const homeStatLoader = document.getElementById('homeStatLoader');
  if (homeStatLoader) {
    homeStatLoader.textContent = loaderInfo.label;
  }

  const statusBadge = document.getElementById('homeVersionStatusBadge');
  const homeStatLocal = document.getElementById('homeStatLocal');

  if (isLocal) {
    statusBadge.textContent = 'Instalado Localmente';
    statusBadge.className = 'hero-tag-badge status-tag';
    homeStatLocal.textContent = 'En Disco Local';
  } else {
    statusBadge.textContent = 'Listo para Descargar';
    statusBadge.className = 'hero-tag-badge';
    homeStatLocal.textContent = 'En Servidor';
  }

  updateModStatusBanner(loaderInfo);
}

function updateModStatusBanner(loaderInfo) {
  const banner = document.getElementById('modStatusBanner');
  if (!banner) return;

  if (loaderInfo.type === 'vanilla') {
    banner.className = 'mod-status-banner warning';
    banner.innerHTML = `
      <div class="mod-status-banner-content">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <span>
          <strong>Versión Vanilla:</strong> Minecraft Vanilla oficial no ejecuta mods (.jar). Para usar mods, instala o selecciona Fabric o Quilt.
        </span>
      </div>
      <button class="mod-status-banner-btn" id="btnBannerInstallFabric">Instalar Fabric</button>
    `;

    const btn = document.getElementById('btnBannerInstallFabric');
    if (btn) {
      btn.addEventListener('click', () => {
        openInstallLoaderModal('fabric');
      });
    }
  } else {
    banner.className = 'mod-status-banner success';
    banner.innerHTML = `
      <div class="mod-status-banner-content">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>
          <strong>Cargador ${loaderInfo.label} activo:</strong> Los mods compatibles colocados en la carpeta mods se cargarán automáticamente al iniciar el juego.
        </span>
      </div>
      <button class="mod-status-banner-btn" style="background: rgba(16, 185, 129, 0.2); border-color: #10b981; color: #a7f3d0;" id="btnBannerChangeLoader">Cambiar Versión</button>
    `;

    const btnChange = document.getElementById('btnBannerChangeLoader');
    if (btnChange) {
      btnChange.addEventListener('click', () => {
        openInstallLoaderModal(loaderInfo.type);
      });
    }
  }
}


// --- Modal de Instalación de Fabric y Quilt ---
let currentSelectedLoaderType = 'fabric';
let cachedFabricGames = null;
let cachedQuiltGames = null;

function setupInstallLoaderHandlers() {
  const modal = document.getElementById('modalInstallLoader');
  const btnOpen = document.getElementById('btnOpenInstallLoaderModal');
  const btnClose = document.getElementById('btnCloseInstallLoaderModal');
  const btnCancel = document.getElementById('btnCancelInstallLoader');
  const btnSubmit = document.getElementById('btnSubmitInstallLoader');
  const choiceFabric = document.getElementById('choiceFabric');
  const choiceQuilt = document.getElementById('choiceQuilt');
  const mcSelect = document.getElementById('loaderMcVersionSelect');
  const loaderSelect = document.getElementById('loaderVersionSelect');

  if (btnOpen) {
    btnOpen.addEventListener('click', () => openInstallLoaderModal('fabric'));
  }
  if (btnClose) {
    btnClose.addEventListener('click', closeInstallLoaderModal);
  }
  if (btnCancel) {
    btnCancel.addEventListener('click', closeInstallLoaderModal);
  }

  if (choiceFabric) {
    choiceFabric.addEventListener('click', () => {
      choiceFabric.classList.add('active');
      choiceQuilt.classList.remove('active');
      currentSelectedLoaderType = 'fabric';
      loadLoaderModalGames('fabric');
    });
  }

  if (choiceQuilt) {
    choiceQuilt.addEventListener('click', () => {
      choiceQuilt.classList.add('active');
      choiceFabric.classList.remove('active');
      currentSelectedLoaderType = 'quilt';
      loadLoaderModalGames('quilt');
    });
  }

  if (mcSelect) {
    mcSelect.addEventListener('change', () => {
      const gameVersion = mcSelect.value;
      if (gameVersion) {
        loadLoaderVersionsForGame(currentSelectedLoaderType, gameVersion);
      }
    });
  }

  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      const gameVersion = mcSelect.value;
      const loaderVersion = loaderSelect.value;
      if (!gameVersion) {
        alert('Por favor, selecciona una versión de Minecraft');
        return;
      }

      const progress = document.getElementById('installLoaderProgress');
      const progressText = document.getElementById('installLoaderStatusText');
      const submitText = document.getElementById('btnSubmitInstallLoaderText');

      try {
        btnSubmit.disabled = true;
        progress.style.display = 'flex';
        progressText.textContent = `Instalando ${currentSelectedLoaderType.toUpperCase()} para Minecraft ${gameVersion}...`;
        submitText.textContent = 'Instalando...';

        const res = await fetch('/api/modloaders/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            loaderType: currentSelectedLoaderType,
            gameVersion: gameVersion,
            loaderVersion: loaderVersion || undefined,
            setAsSelected: true
          })
        });

        const data = await res.json();
        if (data.success) {
          launcherConfig.selectedVersion = data.result.versionId;
          await loadVersionsList();
          updateSelectedVersionDisplay();
          closeInstallLoaderModal();

          const btnHome = document.querySelector('.nav-item[data-view="home"]');
          if (btnHome) btnHome.click();
        } else {
          alert('Error en instalación: ' + (data.message || 'Fallo desconocido'));
        }
      } catch (err) {
        alert('Error conectando con el servidor: ' + err.message);
      } finally {
        btnSubmit.disabled = false;
        progress.style.display = 'none';
        submitText.textContent = 'Instalar y Seleccionar';
      }
    });
  }
}

async function openInstallLoaderModal(defaultLoader = 'fabric') {
  const modal = document.getElementById('modalInstallLoader');
  const choiceFabric = document.getElementById('choiceFabric');
  const choiceQuilt = document.getElementById('choiceQuilt');

  currentSelectedLoaderType = defaultLoader;
  if (defaultLoader === 'quilt') {
    if (choiceQuilt) choiceQuilt.classList.add('active');
    if (choiceFabric) choiceFabric.classList.remove('active');
  } else {
    if (choiceFabric) choiceFabric.classList.add('active');
    if (choiceQuilt) choiceQuilt.classList.remove('active');
  }

  if (modal) modal.classList.add('active');
  await loadLoaderModalGames(currentSelectedLoaderType);
}

function closeInstallLoaderModal() {
  const modal = document.getElementById('modalInstallLoader');
  if (modal) modal.classList.remove('active');
}

async function loadLoaderModalGames(loaderType) {
  const mcSelect = document.getElementById('loaderMcVersionSelect');
  if (!mcSelect) return;
  mcSelect.innerHTML = '<option value="">Cargando versiones soportadas...</option>';

  try {
    let games = [];
    if (loaderType === 'fabric') {
      if (!cachedFabricGames) {
        const res = await fetch('/api/modloaders/fabric/games');
        const data = await res.json();
        cachedFabricGames = data.games || [];
      }
      games = cachedFabricGames;
    } else {
      if (!cachedQuiltGames) {
        const res = await fetch('/api/modloaders/quilt/games');
        const data = await res.json();
        cachedQuiltGames = data.games || [];
      }
      games = cachedQuiltGames;
    }

    mcSelect.innerHTML = '';
    
    // Identificar versión sugerida basada en la seleccionada actualmente o la más reciente
    const currentBase = launcherConfig ? (getLoaderInfo(launcherConfig.selectedVersion).baseVersion) : null;

    games.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.version;
      opt.textContent = `${g.version}${g.stable ? ' (Estable)' : ' (Snapshot / Pre)'}`;
      if (currentBase && g.version === currentBase) {
        opt.selected = true;
      }
      mcSelect.appendChild(opt);
    });

    // Cargar loaders para la versión seleccionada por defecto
    const initialGame = mcSelect.value || (games[0] ? games[0].version : null);
    if (initialGame) {
      loadLoaderVersionsForGame(loaderType, initialGame);
    }
  } catch (err) {
    mcSelect.innerHTML = '<option value="">Error cargando versiones</option>';
  }
}

async function loadLoaderVersionsForGame(loaderType, gameVersion) {
  const loaderSelect = document.getElementById('loaderVersionSelect');
  if (!loaderSelect) return;
  loaderSelect.innerHTML = '<option value="">Buscando versiones del cargador...</option>';

  try {
    const endpoint = loaderType === 'fabric'
      ? `/api/modloaders/fabric/loaders?gameVersion=${encodeURIComponent(gameVersion)}`
      : `/api/modloaders/quilt/loaders?gameVersion=${encodeURIComponent(gameVersion)}`;

    const res = await fetch(endpoint);
    const data = await res.json();
    const loaders = data.loaders || [];

    loaderSelect.innerHTML = '';
    loaders.forEach((l, idx) => {
      const opt = document.createElement('option');
      opt.value = l.version;
      opt.textContent = `${l.version}${l.stable ? ' (Recomendada)' : ' (Beta)'}`;
      if (idx === 0) opt.selected = true;
      loaderSelect.appendChild(opt);
    });

    if (loaders.length === 0) {
      loaderSelect.innerHTML = '<option value="">No se encontraron loaders compatibles</option>';
    }
  } catch (err) {
    loaderSelect.innerHTML = '<option value="">Error cargando versiones del cargador</option>';
  }
}


// --- Lanzamiento del Juego ---
function setupPlayHandler() {
  const btnPlay = document.getElementById('btnPlay');
  const playBtnText = document.getElementById('playBtnText');

  btnPlay.addEventListener('click', async () => {
    if (btnPlay.classList.contains('disabled')) return;

    // Validar si existe una cuenta seleccionada
    if (!launcherConfig || !launcherConfig.accounts || launcherConfig.accounts.length === 0 || !launcherConfig.selectedAccountId) {
      document.getElementById('modalOffline').classList.add('active');
      document.getElementById('offlineUsernameInput').focus();
      return;
    }

    try {
      playBtnText.textContent = 'INICIANDO...';
      btnPlay.classList.add('disabled');

      const res = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: launcherConfig.selectedVersion })
      });
      const data = await res.json();
      if (!data.success) {
        alert('Error: ' + data.message);
        playBtnText.textContent = 'JUGAR';
        btnPlay.classList.remove('disabled');
      }
    } catch (e) {
      alert('Fallo de conexión al lanzar: ' + e.message);
      playBtnText.textContent = 'JUGAR';
      btnPlay.classList.remove('disabled');
    }
  });
}

// --- Sistema de Actualización Automática ---
let currentAvailableUpdate = null;

function setupUpdateHandlers() {
  const topbarBadge = document.getElementById('topbarUpdateBadge');
  const topbarText = document.getElementById('topbarUpdateText');
  const modalUpdate = document.getElementById('modalUpdate');
  const btnCloseModal = document.getElementById('btnCloseUpdateModal');
  const btnPostpone = document.getElementById('btnPostponeUpdate');
  const btnStartUpdate = document.getElementById('btnStartUpdate');
  const btnStartUpdateText = document.getElementById('btnStartUpdateText');
  const curVerSpan = document.getElementById('updateCurrentVer');
  const newVerSpan = document.getElementById('updateNewVer');
  const changelogBox = document.getElementById('updateChangelogBox');
  const progressContainer = document.getElementById('updateProgressContainer');
  const progressStatusText = document.getElementById('updateProgressStatusText');
  const progressPercentText = document.getElementById('updateProgressPercentText');
  const progressBarFill = document.getElementById('updateProgressBarFill');

  if (topbarBadge) {
    topbarBadge.addEventListener('click', () => {
      if (currentAvailableUpdate) {
        modalUpdate.classList.add('active');
      }
    });
  }

  if (btnCloseModal) {
    btnCloseModal.addEventListener('click', () => modalUpdate.classList.remove('active'));
  }
  if (btnPostpone) {
    btnPostpone.addEventListener('click', () => modalUpdate.classList.remove('active'));
  }

  if (btnStartUpdate) {
    btnStartUpdate.addEventListener('click', async () => {
      if (!currentAvailableUpdate || !currentAvailableUpdate.downloadUrl) return;

      try {
        btnStartUpdate.disabled = true;
        btnStartUpdateText.textContent = 'Actualizando...';
        if (progressContainer) progressContainer.style.display = 'flex';
        if (progressStatusText) progressStatusText.textContent = 'Iniciando descarga del paquete oficial...';
        if (progressPercentText) progressPercentText.textContent = '0%';
        if (progressBarFill) progressBarFill.style.width = '0%';

        const res = await fetch('/api/updates/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ downloadUrl: currentAvailableUpdate.downloadUrl })
        });
        const data = await res.json();
        if (!data.success) {
          alert('Error al actualizar: ' + data.message);
          btnStartUpdate.disabled = false;
          btnStartUpdateText.textContent = 'Actualizar Ahora';
          if (progressContainer) progressContainer.style.display = 'none';
        }
      } catch (err) {
        alert('Error de conexión al aplicar actualización: ' + err.message);
        btnStartUpdate.disabled = false;
        btnStartUpdateText.textContent = 'Actualizar Ahora';
        if (progressContainer) progressContainer.style.display = 'none';
      }
    });
  }

  // Verificación automática en segundo plano tras 2.5 segundos
  setTimeout(async () => {
    try {
      const res = await fetch('/api/updates/check');
      const data = await res.json();
      if (data.success && data.update && data.update.hasUpdate) {
        currentAvailableUpdate = data.update;
        if (topbarBadge && topbarText) {
          topbarText.textContent = `v${data.update.latestVersion} Disponible`;
          topbarBadge.style.display = 'flex';
        }
        if (curVerSpan) curVerSpan.textContent = data.update.currentVersion;
        if (newVerSpan) newVerSpan.textContent = data.update.latestVersion;
        if (changelogBox) changelogBox.textContent = data.update.releaseNotes || 'Mejoras y correcciones generales.';

        // Mostrar modal amigable automáticamente una vez por sesión
        if (!sessionStorage.getItem('update_notified_' + data.update.latestVersion)) {
          sessionStorage.setItem('update_notified_' + data.update.latestVersion, 'true');
          modalUpdate.classList.add('active');
        }
      }
    } catch (e) {}
  }, 2500);
}

// --- Server-Sent Events (SSE) en Tiempo Real ---
function setupSSE() {
  const evtSource = new EventSource('/api/events');

  const btnPlay = document.getElementById('btnPlay');
  const playBtnText = document.getElementById('playBtnText');
  const progressBarContainer = document.getElementById('progressBarContainer');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressStatusText = document.getElementById('progressStatusText');
  const progressPercentageText = document.getElementById('progressPercentageText');
  const terminalOutput = document.getElementById('terminalOutput');

  evtSource.addEventListener('status', (e) => {
    try {
      const status = JSON.parse(e.data);

      if (status.state === 'idle') {
        btnPlay.classList.remove('disabled', 'running');
        playBtnText.textContent = 'JUGAR';
        progressBarContainer.classList.remove('active');
        loadVersionsList();
      } else if (status.state === 'running') {
        btnPlay.classList.remove('disabled');
        btnPlay.classList.add('running');
        playBtnText.textContent = 'JUGANDO';
        progressBarContainer.classList.remove('active');

        if (launcherConfig && launcherConfig.closeOnLaunch !== false) {
          setTimeout(() => {
            if (window.chrome && window.chrome.webview) {
              window.chrome.webview.postMessage('close');
            } else {
              window.close();
            }
          }, 1200);
        }
      } else {
        btnPlay.classList.add('disabled');
        progressBarContainer.classList.add('active');
        progressStatusText.textContent = status.message;
        progressPercentageText.textContent = `${status.progress}%`;
        progressBarFill.style.width = `${status.progress}%`;
      }
    } catch (err) {}
  });

  evtSource.addEventListener('log', (e) => {
    try {
      const log = JSON.parse(e.data);
      const line = document.createElement('div');
      line.className = `log-line ${log.type || 'info'}`;
      line.textContent = `[${log.timestamp}] ${log.text}`;
      terminalOutput.appendChild(line);

      terminalOutput.scrollTop = terminalOutput.scrollHeight;
    } catch (err) {}
  });

  evtSource.addEventListener('updateProgress', (e) => {
    try {
      const data = JSON.parse(e.data);
      const progressContainer = document.getElementById('updateProgressContainer');
      const progressStatusText = document.getElementById('updateProgressStatusText');
      const progressPercentText = document.getElementById('updateProgressPercentText');
      const progressBarFill = document.getElementById('updateProgressBarFill');
      const btnStartUpdate = document.getElementById('btnStartUpdate');
      const btnStartUpdateText = document.getElementById('btnStartUpdateText');

      if (progressContainer) progressContainer.style.display = 'flex';
      if (progressStatusText) progressStatusText.textContent = data.message;
      if (progressPercentText && data.progress !== undefined) progressPercentText.textContent = `${data.progress}%`;
      if (progressBarFill && data.progress !== undefined) progressBarFill.style.width = `${data.progress}%`;

      if (data.done) {
        if (btnStartUpdateText) btnStartUpdateText.textContent = 'Actualizado';
        setTimeout(() => {
          window.location.reload();
        }, 1800);
      } else if (data.error) {
        if (btnStartUpdate) btnStartUpdate.disabled = false;
        if (btnStartUpdateText) btnStartUpdateText.textContent = 'Reintentar Actualización';
      }
    } catch (err) {}
  });

  evtSource.onerror = () => {};
}

// ========================================================
// 1. PANTALLA DE CARGA (SPLASH SCREEN)
// ========================================================
function showSplash() {
  const splash = document.getElementById('splashScreen');
  if (splash) {
    splash.classList.remove('fade-out');
  }
}

function hideSplash() {
  const splash = document.getElementById('splashScreen');
  const statusText = document.getElementById('splashStatusText');
  if (statusText) statusText.textContent = 'Entorno cargado';
  if (splash) {
    setTimeout(() => {
      splash.classList.add('fade-out');
      setTimeout(() => {
        splash.style.display = 'none';
      }, 550);
    }, 450);
  }
}

// ========================================================
// 2. PARTÍCULAS PIXELADAS MINECRAFT EN EL FONDO
// ========================================================
function initPixelParticles() {
  const canvas = document.getElementById('pixelCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  const PARTICLE_COUNT = 30;
  const particles = [];

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: Math.floor(Math.random() * 4) + 2,
      speedY: -(Math.random() * 0.4 + 0.12),
      speedX: (Math.random() - 0.5) * 0.2,
      opacity: Math.random() * 0.45 + 0.15,
      opacityDelta: (Math.random() * 0.007 + 0.002) * (Math.random() > 0.5 ? 1 : -1)
    });
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const style = getComputedStyle(document.documentElement);
    const accentColor = style.getPropertyValue('--accent-cyan').trim() || '#00f0ff';

    for (let p of particles) {
      p.y += p.speedY;
      p.x += p.speedX;
      p.opacity += p.opacityDelta;

      if (p.opacity > 0.6 || p.opacity < 0.1) {
        p.opacityDelta = -p.opacityDelta;
      }

      if (p.y < -10) {
        p.y = canvas.height + 10;
        p.x = Math.random() * canvas.width;
      }
      if (p.x < -10) p.x = canvas.width + 10;
      if (p.x > canvas.width + 10) p.x = -10;

      ctx.save();
      ctx.globalAlpha = Math.max(0.05, Math.min(1, p.opacity));
      ctx.fillStyle = accentColor;
      ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
      ctx.restore();
    }

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

// ========================================================
// 3. NOVEDADES Y NOTICIAS DE MOJANG
// ========================================================
async function loadMojangNews() {
  const container = document.getElementById('newsCardsGrid');
  if (!container) return;

  try {
    const res = await fetch('/api/news');
    const data = await res.json();

    if (data.success && Array.isArray(data.news) && data.news.length > 0) {
      container.innerHTML = '';
      data.news.forEach(item => {
        const card = document.createElement('div');
        card.className = 'news-card';

        let imgUrl = item.imageUrl || '';
        if (!imgUrl) {
          if (item.newsPageImage && item.newsPageImage.url) {
            imgUrl = item.newsPageImage.url.startsWith('http') ? item.newsPageImage.url : 'https://launchercontent.mojang.com' + item.newsPageImage.url;
          } else if (item.playPageImage && item.playPageImage.url) {
            imgUrl = item.playPageImage.url.startsWith('http') ? item.playPageImage.url : 'https://launchercontent.mojang.com' + item.playPageImage.url;
          }
        }
        if (!imgUrl) {
          imgUrl = 'https://launchercontent.mojang.com/images/4bBqdKap4YSe87kbAvlyzz-MinecraftEducationPlanetEarth3Launcher772x350.jpeg';
        }

        const tag = item.tag || item.category || 'Novedad';
        const title = item.title || 'Actualización de Minecraft';
        const desc = item.text || 'Consulta los detalles de esta actualización oficial de Minecraft.';
        const readUrl = item.readMoreUrl || item.cardPath || 'https://www.minecraft.net';

        card.innerHTML = `
          <div class="news-card-thumb" style="${imgUrl ? `background-image: url('${imgUrl}')` : 'background: linear-gradient(135deg, #1e293b, #0f172a);'}">
            <span class="news-card-tag-pill">${tag}</span>
          </div>
          <div class="news-card-body">
            <h4 class="news-card-title">${title}</h4>
            <p class="news-card-desc">${desc}</p>
            <div class="news-card-footer">
              <span>Leer artículo</span>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          </div>
        `;

        card.addEventListener('click', () => {
          if (window.chrome && window.chrome.webview) {
            window.chrome.webview.postMessage('openUrl:' + readUrl);
          } else {
            window.open(readUrl, '_blank');
          }
        });

        container.appendChild(card);
      });
    } else {
      container.innerHTML = '<div class="news-card-skeleton">No se pudieron cargar noticias en este momento.</div>';
    }
  } catch (err) {
    container.innerHTML = '<div class="news-card-skeleton">Modo sin conexión. Noticias no disponibles.</div>';
  }
}

// ========================================================
// 4. GESTOR DE PERFILES E INSTANCIAS
// ========================================================
function setupProfileHandlers() {
  const btnManage = document.getElementById('btnManageProfiles');
  const modal = document.getElementById('modalProfiles');
  const btnClose = document.getElementById('btnCloseProfilesModal');
  const btnCancel = document.getElementById('btnCancelProfiles');
  const btnSubmit = document.getElementById('btnCreateProfileSubmit');

  if (btnManage) {
    btnManage.addEventListener('click', () => {
      populateProfileVersionSelect();
      loadProfilesList();
      if (modal) modal.classList.add('active');
    });
  }

  if (btnClose) btnClose.addEventListener('click', () => modal && modal.classList.remove('active'));
  if (btnCancel) btnCancel.addEventListener('click', () => modal && modal.classList.remove('active'));

  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      const nameInput = document.getElementById('newProfileNameInput');
      const verSelect = document.getElementById('newProfileVersionSelect');
      const ramInput = document.getElementById('newProfileRamInput');
      const isolateCheck = document.getElementById('newProfileIsolateCheckbox');

      const name = (nameInput.value || '').trim();
      if (!name) {
        alert('Por favor introduce un nombre para el perfil.');
        return;
      }

      btnSubmit.disabled = true;
      btnSubmit.textContent = 'Creando...';

      try {
        const res = await fetch('/api/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            version: verSelect ? verSelect.value : launcherConfig.selectedVersion,
            ram: parseInt(ramInput.value, 10) || 4,
            isolateFolder: isolateCheck ? isolateCheck.checked : true,
            selectImmediately: true
          })
        });

        const data = await res.json();
        if (data.success) {
          launcherConfig = data.config;
          updateUIFromConfig();
          nameInput.value = '';
          await loadProfilesList();
          if (modal) modal.classList.remove('active');
        } else {
          alert('Error creando perfil: ' + (data.message || 'Error desconocido'));
        }
      } catch (err) {
        alert('Error de conexión al crear perfil: ' + err.message);
      } finally {
        btnSubmit.disabled = false;
        btnSubmit.textContent = 'Crear y Usar Perfil';
      }
    });
  }
}

function populateProfileVersionSelect() {
  const select = document.getElementById('newProfileVersionSelect');
  if (!select) return;
  select.innerHTML = '';

  const opts = [];
  if (localVersions && localVersions.length > 0) {
    opts.push(...localVersions.map(v => ({ id: v.id, label: `${v.id} (Instalada)` })));
  }
  if (allVersions && allVersions.length > 0) {
    allVersions.slice(0, 15).forEach(v => {
      if (!opts.some(o => o.id === v.id)) {
        opts.push({ id: v.id, label: `${v.id} (${v.type || 'oficial'})` });
      }
    });
  }

  if (opts.length === 0) {
    opts.push({ id: '26.2', label: '26.2 (Recomendada)' });
  }

  opts.forEach(opt => {
    const el = document.createElement('option');
    el.value = opt.id;
    el.textContent = opt.label;
    if (launcherConfig && launcherConfig.selectedVersion === opt.id) {
      el.selected = true;
    }
    select.appendChild(el);
  });
}

async function loadProfilesList() {
  const container = document.getElementById('profilesListContainer');
  const activeLabel = document.getElementById('activeProfileNameLabel');

  try {
    const res = await fetch('/api/profiles');
    const data = await res.json();

    if (!data.success) return;
    const profiles = data.profiles || [];
    const activeId = data.activeProfileId;

    if (activeLabel) {
      const activeProf = profiles.find(p => p.id === activeId);
      activeLabel.textContent = activeProf ? `${activeProf.name} (${activeProf.version})` : 'Predeterminado (Global)';
    }

    if (!container) return;
    container.innerHTML = '';

    // Perfil Default
    const isDefActive = !activeId;
    const defCard = document.createElement('div');
    defCard.className = `profile-entry-card ${isDefActive ? 'active' : ''}`;
    defCard.innerHTML = `
      <div class="profile-entry-left">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-cyan);">
          <polygon points="12 2 2 7 12 12 22 7 12 12"></polygon>
          <polyline points="2 17 12 22 22 17"></polyline>
          <polyline points="2 12 12 17 22 12"></polyline>
        </svg>
        <div>
          <div class="profile-entry-name">Predeterminado (Global)</div>
          <div class="profile-entry-details">Directorio estándar .minecraft</div>
        </div>
      </div>
      <div class="profile-entry-actions">
        ${isDefActive ? '<span style="font-size: 11px; font-weight: 700; color: var(--accent-cyan);">ACTIVO</span>' : '<button class="btn-secondary btn-sm" id="btnSelectDefProf">Activar</button>'}
      </div>
    `;

    const selectDefBtn = defCard.querySelector('#btnSelectDefProf');
    if (selectDefBtn) {
      selectDefBtn.addEventListener('click', async () => {
        await fetch('/api/profiles/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'default' })
        });
        await loadInitialConfig();
        await loadProfilesList();
      });
    }
    container.appendChild(defCard);

    // Perfiles Custom
    profiles.forEach(prof => {
      const isAct = prof.id === activeId;
      const card = document.createElement('div');
      card.className = `profile-entry-card ${isAct ? 'active' : ''}`;
      card.innerHTML = `
        <div class="profile-entry-left">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="color: ${isAct ? 'var(--accent-cyan)' : 'var(--text-dim)'};">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          <div>
            <div class="profile-entry-name">${prof.name}</div>
            <div class="profile-entry-details">Versión: ${prof.version} | RAM: ${prof.ram} GB</div>
          </div>
        </div>
        <div class="profile-entry-actions">
          ${isAct ? '<span style="font-size: 11px; font-weight: 700; color: var(--accent-cyan);">ACTIVO</span>' : `<button class="btn-secondary btn-sm" data-select="${prof.id}">Activar</button>`}
          <button class="btn-secondary btn-sm" data-delete="${prof.id}" style="color: #ef4444;" title="Eliminar perfil">&times;</button>
        </div>
      `;

      const selBtn = card.querySelector(`[data-select="${prof.id}"]`);
      if (selBtn) {
        selBtn.addEventListener('click', async () => {
          await fetch('/api/profiles/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: prof.id })
          });
          await loadInitialConfig();
          await loadProfilesList();
        });
      }

      const delBtn = card.querySelector(`[data-delete="${prof.id}"]`);
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!confirm(`¿Eliminar perfil "${prof.name}"?`)) return;
          await fetch(`/api/profiles/${prof.id}`, { method: 'DELETE' });
          await loadInitialConfig();
          await loadProfilesList();
        });
      }

      container.appendChild(card);
    });
  } catch (e) {}
}

