const crypto = require('crypto');
const https = require('https');

function generateOfflineUUID(username) {
  const md5sum = crypto.createHash('md5');
  md5sum.update('OfflinePlayer:' + username, 'utf8');
  const buffer = md5sum.digest();

  buffer[6] = (buffer[6] & 0x0f) | 0x30;
  buffer[8] = (buffer[8] & 0x3f) | 0x80;

  const hex = buffer.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join('-');
}

function createOfflineAccount(username) {
  const cleanName = username.trim().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
  if (!cleanName) {
    throw new Error('El nombre de usuario solo puede contener letras, números y guiones bajos.');
  }
  const uuid = generateOfflineUUID(cleanName);
  return {
    id: 'offline_' + uuid,
    type: 'offline',
    username: cleanName,
    uuid: uuid,
    avatarUrl: `https://mc-heads.net/avatar/${cleanName}/100`,
    createdAt: Date.now()
  };
}

// Client ID público estándar para autenticación de Minecraft en Windows
const MS_CLIENT_ID = '00000000402b5328';

function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Timeout: sin respuesta de los servidores de Microsoft (15s)'));
    });
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

function formatUUID(cleanUuid) {
  if (cleanUuid.length === 32) {
    return [
      cleanUuid.substring(0, 8),
      cleanUuid.substring(8, 12),
      cleanUuid.substring(12, 16),
      cleanUuid.substring(16, 20),
      cleanUuid.substring(20, 32)
    ].join('-');
  }
  return cleanUuid;
}

// ============================================================
// LIVE CONNECT DEVICE CODE FLOW — endpoint correcto para client 00000000402b5328
// Usar login.live.com, NO login.microsoftonline.com
// ============================================================

async function startMicrosoftDeviceCode() {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    scope: 'service::user.auth.xboxlive.com::MBI_SSL',
    response_type: 'device_code'
  }).toString();

  const res = await httpsRequest({
    hostname: 'login.live.com',
    path: '/oauth20_connect.srf',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (res.status === 200 && res.data && res.data.device_code) {
    return {
      success: true,
      deviceCode: res.data.device_code,
      userCode: res.data.user_code,
      verificationUrl: res.data.verification_uri || 'https://microsoft.com/link',
      expiresIn: res.data.expires_in || 900,
      interval: res.data.interval || 5
    };
  }

  const errMsg = (res.data && (res.data.error_description || res.data.error)) ||
                 res.raw ||
                 'No se pudo iniciar la conexión con Microsoft. Verifica tu internet.';
  throw new Error(errMsg);
}

async function pollMicrosoftToken(deviceCode) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  }).toString();

  const res = await httpsRequest({
    hostname: 'login.live.com',
    path: '/oauth20_token.srf',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (res.data && res.data.error) {
    if (res.data.error === 'authorization_pending') {
      return { status: 'pending' };
    }
    if (res.data.error === 'expired_token') {
      return { status: 'expired_token', message: 'El código expiró. Intenta de nuevo.' };
    }
    return { status: 'error', message: res.data.error_description || res.data.error };
  }

  if (res.status === 200 && res.data && res.data.access_token) {
    try {
      const mcAccount = await authenticateMinecraftFromMsToken(res.data.access_token);
      return { status: 'complete', account: mcAccount };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  return { status: 'pending' };
}

async function authenticateMinecraftFromMsToken(msAccessToken) {
  // 1. Xbox Live User Authentication
  // Nota: Live Connect tokens usan prefijo 't=' (NO 'd=')
  const xblRes = await httpsRequest({
    hostname: 'user.auth.xboxlive.com',
    path: '/user/authenticate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  }, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: 't=' + msAccessToken
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });

  const xblToken = xblRes.data && xblRes.data.Token;
  const xblXui = xblRes.data && xblRes.data.DisplayClaims && xblRes.data.DisplayClaims.xui;
  const uhs = xblXui && xblXui[0] && xblXui[0].uhs;
  if (!xblToken || !uhs) {
    throw new Error('Fallo en la autenticación de Xbox Live. Asegúrate de tener una cuenta de Xbox activa vinculada a tu Microsoft.');
  }

  // 2. XSTS Token (Xbox Security Token Service)
  const xstsRes = await httpsRequest({
    hostname: 'xsts.auth.xboxlive.com',
    path: '/xsts/authorize',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  }, {
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xblToken]
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });

  if (xstsRes.status === 401 && xstsRes.data && xstsRes.data.XErr) {
    const errCode = xstsRes.data.XErr;
    if (errCode === 2148916233) {
      throw new Error('Esta cuenta de Microsoft es de un menor y requiere estar vinculada a una cuenta familiar de Xbox.');
    } else if (errCode === 2148916238) {
      throw new Error('La cuenta no tiene un perfil de Xbox. Entra en xbox.com, crea tu perfil, y vuelve a intentarlo.');
    }
    throw new Error('Error XSTS ' + errCode + '. Verifica tu cuenta de Xbox.');
  }

  const xstsToken = xstsRes.data && xstsRes.data.Token;
  const xstsXui = xstsRes.data && xstsRes.data.DisplayClaims && xstsRes.data.DisplayClaims.xui;
  const xuid = (xstsXui && xstsXui[0] && xstsXui[0].xid) || '0';
  if (!xstsToken) {
    throw new Error('Fallo en la autorización XSTS de Minecraft. Inténtalo de nuevo.');
  }

  // 3. Minecraft Service Login
  const mcLoginRes = await httpsRequest({
    hostname: 'api.minecraftservices.com',
    path: '/authentication/login_with_xbox',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  }, {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  });

  const mcToken = mcLoginRes.data?.access_token;
  if (!mcToken) {
    throw new Error('Fallo al obtener el token oficial de Minecraft Services.');
  }

  // 4. Obtener Perfil oficial de Minecraft
  const profileRes = await httpsRequest({
    hostname: 'api.minecraftservices.com',
    path: '/minecraft/profile',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${mcToken}` }
  });

  if (!profileRes.data?.id || !profileRes.data?.name) {
    throw new Error('Esta cuenta de Microsoft no tiene una copia comprada de Minecraft Java Edition.');
  }

  const formattedUuid = formatUUID(profileRes.data.id);

  return {
    id: 'ms_' + profileRes.data.id,
    type: 'microsoft',
    username: profileRes.data.name,
    uuid: formattedUuid,
    accessToken: mcToken,
    xuid: xuid,
    avatarUrl: `https://mc-heads.net/avatar/${profileRes.data.name}/100`,
    createdAt: Date.now()
  };
}

module.exports = {
  createOfflineAccount,
  generateOfflineUUID,
  startMicrosoftDeviceCode,
  pollMicrosoftToken
};
