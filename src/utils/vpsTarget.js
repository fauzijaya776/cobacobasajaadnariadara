const ssh = require('./ssh');

/**
 * Parse input user menjadi { ip, port }.
 * Menerima:
 *   "1.2.3.4"          -> { ip, port: null }  (port dideteksi otomatis nanti)
 *   "1.2.3.4:2222"     -> { ip, port: 2222 }
 *   "1.2.3.4 2222"     -> { ip, port: 2222 }
 *   "root@1.2.3.4:22"  -> { ip, port: 22, username: 'root' }
 */
function parseVpsInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'EMPTY' };

  const match = text.match(
    /^(?:([A-Za-z0-9_.-]+)@)?((?:\d{1,3}\.){3}\d{1,3})(?:[:\s]+(\d{1,5}))?$/
  );
  if (!match) return { error: 'FORMAT' };

  const [, username, ip, portStr] = match;

  // Validasi tiap oktet — regex saja meloloskan 999.999.999.999
  const octets = ip.split('.').map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return { error: 'OCTET' };
  }
  if (octets[0] === 0 || octets[0] === 127) {
    return { error: 'RESERVED' };
  }

  let port = null;
  if (portStr) {
    port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: 'PORT' };
    }
  }

  return { ip, port, username: username || null };
}

/**
 * Tentukan port SSH yang dipakai.
 * Kalau user sudah menyebut port, port itu diverifikasi dulu; kalau ternyata
 * tertutup, sistem tetap mencoba port umum lain agar user tidak buntu.
 */
async function resolveSSHPort(ip, explicitPort) {
  if (explicitPort) {
    const open = await ssh.probeSSHPort(ip, explicitPort);
    if (open) return { port: explicitPort, autoDetected: false };

    const fallback = await ssh.detectSSHPort(ip);
    if (fallback) return { port: fallback, autoDetected: true, requestedPort: explicitPort };

    return { port: null, autoDetected: false, requestedPort: explicitPort };
  }

  const detected = await ssh.detectSSHPort(ip);
  return { port: detected, autoDetected: detected !== null && detected !== 22 };
}

const INPUT_ERROR_MESSAGES = {
  EMPTY: 'Input kosong.',
  FORMAT: 'Format tidak dikenali.',
  OCTET: 'Angka IP di luar rentang 0-255.',
  RESERVED: 'IP tersebut tidak bisa dipakai.',
  PORT: 'Nomor port harus antara 1 dan 65535.'
};

module.exports = {
  parseVpsInput,
  resolveSSHPort,
  INPUT_ERROR_MESSAGES
};
