// --- Estado Global del Launcher ---
let launcherConfig = null;
let allVersions = [];
let localVersions = [];
let activeFilter = 'all';
let msPollingInterval = null;
let activeModsTab = 'mods';

// --- Inicialización al Cargar el DOM ---
document.addEventListener('DOMContentLoaded', async () => {
  setupWindowControls();
  setupNavigation();
  setupAccountHandlers();
  setupSettingsHandlers();
  setupCustomizationHandlers();
  setupModsHandlers();
  setupVersionsHandlers();
  setupInstallLoaderHandlers();
  setupPlayHandler();
  setupSSE();

  await loadInitialConfig();
  await loadVersionsList();
  await loadModsList();
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
    });
  });

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
      const name = offlineInput.value.trim() || 'MHF_Steve';
      offlineAvatarPreview.src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/80`;
    }, 400);
  });

  btnSubmitOffline.addEventListener('click', async () => {
    const name = offlineInput.value.trim();
    if (!name) return;

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
      }
    } catch (e) {
      alert('Error guardando cuenta: ' + e.message);
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
      accentColor: activeThemeBtn ? activeThemeBtn.getAttribute('data-color') : '#00f0ff',
      themePreset: activeThemeBtn ? activeThemeBtn.getAttribute('data-preset') : 'cyan',
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

  evtSource.onerror = () => {};
}
