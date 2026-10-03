/**
 * SSH online untuk website: browser (xterm.js) <-> WebSocket <-> SSH ke VPS.
 *
 * Vercel tidak bisa meneruskan WebSocket, jadi browser terhubung LANGSUNG ke
 * server bot (Render) memakai tiket sekali pakai yang diminta lewat API biasa
 * (yang sudah memeriksa cookie login). Kredensial SSH dikirim lewat WSS dan
 * tidak pernah disimpan.
 *
 * Protokol:
 *   browser -> server : teks JSON {type:'connect'|'data'|'resize', ...}
 *   server  -> browser: biner = keluaran terminal, teks JSON = status/kontrol
 */
const dns = require('dns').promises;
const net = require('net');
const { WebSocketServer } = require('ws');
const ssh = require('./utils/ssh');

const MAX_PER_USER = 3;
const IDLE_MS = 30 * 60 * 1000;
const MAX_MS = 4 * 60 * 60 * 1000;

/** Alamat yang tidak boleh dituju: jaringan internal server, loopback, dll. */
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivate(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

/** Resolve host sekali lalu sambung ke IP itu (mencegah DNS rebinding). */
async function resolvePublic(host) {
  const h = String(host || '').trim();
  if (!/^[a-zA-Z0-9.:-]{1,253}$/.test(h)) throw new Error('Host tidak valid.');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('Host tidak ditemukan.');
  if (addrs.some((a) => isPrivate(a.address))) throw new Error('Alamat jaringan privat/lokal tidak diizinkan.');
  return addrs[0].address;
}

const ERR = {
  SSH_AUTH: 'Username atau password/key salah.',
  SSH_REFUSED: 'Koneksi ditolak — layanan SSH tidak berjalan di port itu.',
  SSH_TIMEOUT: 'VPS tidak merespons. Cek IP, port, dan firewall.',
  SSH_RESET: 'Koneksi diputus VPS (firewall/fail2ban?).',
  SSH_DNS: 'Host tidak ditemukan.',
  SSH_HANDSHAKE: 'Algoritma SSH tidak cocok (OS terlalu lama).'
};
function friendly(e) {
  const raw = String((e && e.message) || e || 'Gagal terhubung.');
  const code = raw.split(':')[0];
  return ERR[code] || (raw.includes(':') && /^[A-Z_]+$/.test(code) ? raw.slice(raw.indexOf(':') + 1) : raw);
}

const clamp = (n, lo, hi, d) => { const v = parseInt(n, 10); return Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d; };

/**
 * @param {object} o
 * @param {(ticket:string) => ({uid:number, username:string}|null)} o.takeTicket
 * @param {(host:string) => Promise<string>} [o.resolve]  hanya diganti di tes
 */
function createSshGateway({ takeTicket, resolve = resolvePublic }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const active = new Map(); // uid -> jumlah sesi

  const reject = (socket, status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/ssh/ws') return reject(socket, '404 Not Found');
    const t = takeTicket(url.searchParams.get('ticket'));
    if (!t) return reject(socket, '401 Unauthorized');
    if ((active.get(t.uid) || 0) >= MAX_PER_USER) return reject(socket, '429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => session(ws, t));
  }

  function session(ws, t) {
    active.set(t.uid, (active.get(t.uid) || 0) + 1);
    let conn = null;
    let stream = null;
    let ended = false;
    const ctl = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

    let idle;
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => close('Sesi ditutup karena tidak aktif 30 menit.'), IDLE_MS);
    };
    const hard = setTimeout(() => close('Batas sesi 4 jam tercapai.'), MAX_MS);

    function close(reason) {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      clearTimeout(hard);
      if (reason) ctl({ type: 'closed', reason });
      try { if (stream) stream.end(); } catch (_) {}
      try { if (conn) conn.end(); } catch (_) {}
      try { ws.close(); } catch (_) {}
      active.set(t.uid, Math.max(0, (active.get(t.uid) || 1) - 1));
    }

    bump();
    ws.on('close', () => close());
    ws.on('error', () => close());
    ws.on('message', async (raw) => {
      bump();
      let m;
      try { m = JSON.parse(raw.toString()); } catch (_) { return; }

      if (m.type === 'data' && stream) return stream.write(String(m.data || ''));
      if (m.type === 'resize' && stream) return stream.setWindow(clamp(m.rows, 5, 300, 24), clamp(m.cols, 10, 500, 80), 0, 0);
      if (m.type !== 'connect' || conn) return;

      try {
        const port = clamp(m.port, 1, 65535, 22);
        const host = await resolve(m.host);
        ctl({ type: 'status', text: `Menghubungkan ke ${m.host}:${port}…` });
        console.log(`[SSH WEB] user ${t.uid} (${t.username}) -> ${host}:${port}`);
        conn = await ssh.connect({
          host, port,
          username: String(m.username || 'root').slice(0, 64),
          password: m.password ? String(m.password) : undefined,
          privateKey: m.privateKey ? String(m.privateKey) : undefined,
          passphrase: m.passphrase ? String(m.passphrase) : undefined,
          readyTimeout: 20000
        });
        if (ended) { conn.end(); return; }
        conn.on('close', () => close('Koneksi SSH ditutup.'));
        conn.on('error', () => {});
        conn.shell({ term: 'xterm-256color', cols: clamp(m.cols, 10, 500, 80), rows: clamp(m.rows, 5, 300, 24) }, (err, s) => {
          if (err) return close(`Gagal membuka shell: ${err.message}`);
          stream = s;
          ctl({ type: 'ready' });
          const out = (d) => { if (ws.readyState === 1) ws.send(d, { binary: true }); };
          s.on('data', out);
          s.stderr.on('data', out);
          s.on('close', () => close('Sesi selesai.'));
        });
      } catch (e) {
        close(friendly(e));
      }
    });
  }

  return upgrade;
}

module.exports = { createSshGateway, isPrivate };
