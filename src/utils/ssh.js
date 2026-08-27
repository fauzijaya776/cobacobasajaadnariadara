const net = require('net');
const { Client } = require('ssh2');

/**
 * Port SSH yang paling umum dipakai, diurut dari yang paling sering.
 * Dipakai saat user hanya memasukkan IP tanpa port.
 */
const COMMON_SSH_PORTS = [22, 2222, 22022, 2022, 2200, 22222, 8022, 222, 50022];

const BANNER_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 30000;
const KEEPALIVE_INTERVAL_MS = 15000;
const KEEPALIVE_COUNT_MAX = 20;

/**
 * Cek satu port: buka koneksi TCP dan tunggu banner "SSH-..".
 * Resolve true hanya kalau benar-benar ada server SSH di sana.
 */
function probeSSHPort(host, port, timeout = BANNER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeout);

    socket.on('data', (chunk) => {
      done(chunk.toString('utf8', 0, 32).startsWith('SSH-'));
    });
    socket.on('connect', () => {
      // Server SSH mengirim banner duluan. Kalau dalam batas waktu tidak ada
      // banner, kemungkinan besar itu layanan lain (HTTP, dsb).
    });
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.on('close', () => done(false));
  });
}

/**
 * Cek apakah sebuah port TCP terbuka (tanpa memeriksa banner).
 * Dipakai untuk memverifikasi layanan seperti 8006 (viewer) dan 3389 (RDP).
 */
function probeTcpPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/**
 * Cari port SSH yang aktif pada sebuah host.
 * Port 22 dicoba lebih dulu; sisanya diprobe paralel agar cepat.
 *
 * @returns {Promise<number|null>} nomor port, atau null kalau tidak ada yang menjawab
 */
async function detectSSHPort(host, extraPorts = []) {
  const candidates = [...new Set([...extraPorts, ...COMMON_SSH_PORTS])];

  // Port 22 dulu — mayoritas VPS ada di sini, jadi tidak perlu scan penuh.
  if (candidates.includes(22) && (await probeSSHPort(host, 22))) {
    return 22;
  }

  const rest = candidates.filter((p) => p !== 22);
  const results = await Promise.all(
    rest.map(async (port) => ({ port, open: await probeSSHPort(host, port) }))
  );

  // Kembalikan sesuai urutan prioritas di COMMON_SSH_PORTS, bukan urutan selesai.
  for (const port of rest) {
    const hit = results.find((r) => r.port === port && r.open);
    if (hit) return port;
  }
  return null;
}

/**
 * Buka koneksi SSH dengan keepalive aktif.
 * Keepalive penting karena instalasi bisa berjalan puluhan menit dan
 * koneksi idle sering diputus NAT/firewall provider.
 */
function connect({ host, port = 22, username = 'root', password, readyTimeout = READY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      reject(err);
    };

    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve(conn);
    });

    conn.on('error', (err) => fail(normalizeSSHError(err, port)));

    // Kalau koneksi tertutup sebelum 'ready', itu kegagalan — bukan sukses diam-diam.
    conn.on('close', () => fail(new Error('SSH_CLOSED_BEFORE_READY')));

    try {
      conn.connect({
        host,
        port,
        username,
        password,
        readyTimeout,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        tryKeyboard: false,
        algorithms: {
          // Sebagian VPS lama masih memakai algoritma yang tidak lagi default di ssh2.
          serverHostKey: [
            'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'
          ]
        }
      });
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Ubah error ssh2 jadi pesan yang bisa dimengerti user (dan dibedakan di UI).
 */
function normalizeSSHError(err, port) {
  const code = err && err.code;
  const msg = String((err && err.message) || err || '');

  if (code === 'ECONNREFUSED') {
    return new Error(`SSH_REFUSED:Port ${port} menolak koneksi`);
  }
  if (code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || /Timed out/i.test(msg)) {
    return new Error(`SSH_TIMEOUT:Tidak ada balasan dari VPS di port ${port}`);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error('SSH_DNS:IP/host tidak ditemukan');
  }
  if (/All configured authentication methods failed|Authentication failure/i.test(msg)) {
    return new Error('SSH_AUTH:Username atau password salah');
  }
  return new Error(`SSH_ERROR:${msg || 'Gagal terhubung'}`);
}

/**
 * Jalankan perintah dan kembalikan exit code yang SEBENARNYA.
 *
 * Catatan: kalau proses diakhiri oleh sinyal (mis. VPS reboot di tengah
 * instalasi), ssh2 memberi code === null. Itu dilaporkan apa adanya lewat
 * field `signal` supaya pemanggil bisa membedakannya dari kegagalan nyata.
 */
function exec(conn, command, { onLog, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, { pty: false }, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';
      let finished = false;
      let timer = null;

      const finish = (payload) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(payload);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try { stream.close(); } catch (_) {}
          reject(new Error('EXEC_TIMEOUT'));
        }, timeoutMs);
      }

      stream.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        // Batasi buffer agar log panjang tidak memakan memori bot.
        if (stdout.length > 200000) stdout = stdout.slice(-100000);
        if (onLog) onLog(text);
      });

      stream.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        if (stderr.length > 100000) stderr = stderr.slice(-50000);
        if (onLog) onLog(text);
      });

      stream.on('close', (code, signal) => {
        finish({
          code: typeof code === 'number' ? code : null,
          signal: signal || null,
          stdout,
          stderr
        });
      });

      stream.on('error', (streamErr) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        reject(streamErr);
      });
    });
  });
}

/** Buka koneksi, jalankan satu perintah, tutup lagi. */
async function execOnce(target, command, options = {}) {
  const conn = await connect(target);
  try {
    return await exec(conn, command, options);
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

/**
 * Ambil nilai KEY=value dari output shell.
 * Dipakai untuk membaca hasil perintah secara terstruktur, bukan menebak dari exit code.
 */
function readField(output, key) {
  const match = String(output || '').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

module.exports = {
  COMMON_SSH_PORTS,
  probeSSHPort,
  probeTcpPort,
  detectSSHPort,
  connect,
  exec,
  execOnce,
  readField,
  normalizeSSHError
};
