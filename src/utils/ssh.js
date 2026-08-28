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
      // end() menutup dengan FIN (perpisahan normal). destroy() bisa mengirim
      // RST kalau masih ada data server yang belum dibaca — dan koneksi yang
      // diputus kasar berulang kali adalah ciri pemindai port, yang membuat
      // firewall/fail2ban di VPS memblokir kita.
      try { socket.end(); } catch (_) {}
      setTimeout(() => { try { socket.destroy(); } catch (_) {} }, 200);
      resolve(result);
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeout);

    socket.on('data', (chunk) => {
      const adalahSSH = chunk.toString('utf8', 0, 32).startsWith('SSH-');
      if (adalahSSH) {
        // Balas dengan identifikasi kita sebelum menutup, supaya sshd melihat
        // percakapan yang wajar — bukan klien yang menghilang begitu saja.
        try { socket.write('SSH-2.0-RDPBot_PortCheck\r\n'); } catch (_) {}
      }
      done(adalahSSH);
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

  // Port 22 dulu — mayoritas VPS ada di sini, jadi biasanya cukup SATU koneksi
  // dan sisa daftar tidak pernah disentuh.
  if (candidates.includes(22) && (await probeSSHPort(host, 22))) {
    return 22;
  }

  /*
   * Sisanya diperiksa sedikit demi sedikit, BUKAN sekaligus.
   *
   * Membuka 8 koneksi serentak ke banyak port pada satu IP adalah ciri khas
   * pemindaian port. Proteksi DDoS penyedia VPS dan firewall seperti CSF
   * membacanya begitu, lalu memblokir IP kita — dan koneksi SSH berikutnya
   * gagal dengan ECONNRESET, padahal VPS-nya sehat.
   */
  const rest = candidates.filter((p) => p !== 22);
  const UKURAN_BATCH = 2;

  for (let i = 0; i < rest.length; i += UKURAN_BATCH) {
    const batch = rest.slice(i, i + UKURAN_BATCH);
    const hasil = await Promise.all(
      batch.map(async (port) => ({ port, open: await probeSSHPort(host, port) }))
    );
    // Urutan prioritas dipertahankan di dalam batch.
    for (const port of batch) {
      const hit = hasil.find((r) => r.port === port && r.open);
      if (hit) return port;
    }
    // Jeda kecil supaya tidak terlihat seperti pemindaian beruntun.
    if (i + UKURAN_BATCH < rest.length) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return null;
}

/**
 * Buka koneksi SSH dengan keepalive aktif.
 * Keepalive penting karena instalasi bisa berjalan puluhan menit dan
 * koneksi idle sering diputus NAT/firewall provider.
 */
/**
 * Daftar algoritma untuk VPS lama.
 *
 * Hanya dipakai sebagai percobaan TERAKHIR. Server yang sangat tua kadang
 * memutus koneksi begitu saja (ECONNRESET) alih-alih menolak dengan sopan
 * ketika tidak ada algoritma yang cocok.
 */
const ALGORITMA_LAWAS = {
  serverHostKey: [
    'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
    'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss'
  ],
  kex: [
    'curve25519-sha256', 'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'
  ],
  cipher: [
    'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
    'aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes256-cbc', 'aes128-cbc', '3des-cbc'
  ]
};

function connect({ host, port = 22, username = 'root', password, readyTimeout = READY_TIMEOUT_MS, lawas = false }) {
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
        // Secara default JANGAN membatasi daftar algoritma. Menyetel
        // `algorithms` akan MENGGANTI daftar bawaan ssh2, bukan menambahnya —
        // jadi pembatasan hanya mempersempit server yang bisa dihubungi.
        // Daftar lawas cuma dipakai sebagai percobaan terakhir.
        ...(lawas ? { algorithms: ALGORITMA_LAWAS } : {})
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
  // Koneksi diputus paksa oleh sisi sana. Ini yang paling sering membingungkan
  // karena pesan aslinya cuma "read ECONNRESET" dan tidak menjelaskan apa pun.
  if (code === 'ECONNRESET' || code === 'EPIPE' || /ECONNRESET|socket hang up/i.test(msg)) {
    return new Error(`SSH_RESET:Koneksi diputus paksa oleh VPS di port ${port}`);
  }
  if (/Handshake failed|no matching|KEY_EXCHANGE_FAILED/i.test(msg)) {
    return new Error(`SSH_HANDSHAKE:VPS dan bot tidak sepakat soal algoritma enkripsi (${msg})`);
  }
  if (msg === 'SSH_CLOSED_BEFORE_READY') {
    return new Error(`SSH_RESET:VPS menutup koneksi sebelum siap (port ${port})`);
  }
  return new Error(`SSH_ERROR:${msg || 'Gagal terhubung'}`);
}

/** Error yang layak dicoba lagi — gangguan sesaat, bukan salah konfigurasi. */
function bolehDicobaLagi(error) {
  const m = String((error && error.message) || '');
  return /^SSH_RESET|^SSH_TIMEOUT|^SSH_HANDSHAKE|^SSH_ERROR/.test(m);
}

/**
 * Sambungkan dengan percobaan ulang otomatis.
 *
 * Kenapa perlu: ECONNRESET pada koneksi SSH hampir selalu bersifat sesaat —
 * proteksi DDoS penyedia VPS, sshd yang sedang sibuk (MaxStartups), atau
 * jaringan yang bergetar. Percobaan pertama gagal, percobaan kedua beberapa
 * detik kemudian biasanya berhasil.
 *
 * Kegagalan autentikasi TIDAK PERNAH diulang — mengulang password yang salah
 * hanya akan membuat IP bot diblokir fail2ban.
 */
async function connectWithRetry(target, { percobaan = 3, onLog } = {}) {
  let terakhir;

  for (let ke = 1; ke <= percobaan; ke++) {
    try {
      // Percobaan terakhir memakai daftar algoritma lawas, untuk VPS tua yang
      // memutus koneksi tanpa penjelasan saat tidak ada algoritma yang cocok.
      const lawas = ke === percobaan && percobaan > 1;
      return await connect({ ...target, lawas });
    } catch (error) {
      terakhir = error;

      if (!bolehDicobaLagi(error)) throw error;   // auth salah, IP salah, dll.
      if (ke === percobaan) break;

      const jeda = 2000 * ke;                     // 2 detik, lalu 4 detik
      if (onLog) {
        onLog(`Koneksi ke VPS gagal (${error.message}). Mencoba lagi ${ke + 1}/${percobaan} dalam ${jeda / 1000} detik...`);
      }
      console.warn(`[SSH] ${target.host}:${target.port} percobaan ${ke} gagal: ${error.message}`);
      await new Promise((r) => setTimeout(r, jeda));
    }
  }
  throw terakhir;
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
  const conn = await connectWithRetry(target, { percobaan: options.percobaan || 2 });
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
  connectWithRetry,
  bolehDicobaLagi,
  probeSSHPort,
  probeTcpPort,
  detectSSHPort,
  connect,
  exec,
  execOnce,
  readField,
  normalizeSSHError
};
