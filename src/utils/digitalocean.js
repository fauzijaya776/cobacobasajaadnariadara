/**
 * Klien API DigitalOcean.
 *
 * Dipakai fitur "Buat VPS": bot membuat droplet di akun DigitalOcean milik
 * BUYER (buyer memasukkan token pribadinya), lalu mengembalikan IP + password
 * root. Tagihan sewa droplet ditanggung akun buyer; bot hanya memungut biaya
 * layanan Rp1.000 flat per batch.
 *
 * Referensi: https://docs.digitalocean.com/reference/api/reference/
 */
const axios = require('axios');

const API_BASE = 'https://api.digitalocean.com/v2';

/**
 * Daftar region. Diurut mendekati Indonesia lebih dulu (latency terbaik).
 * Slug ini stabil di API DigitalOcean.
 */
const DO_REGIONS = [
  { slug: 'sgp1', name: '🇸🇬 Singapore' },
  { slug: 'blr1', name: '🇮🇳 Bangalore' },
  { slug: 'syd1', name: '🇦🇺 Sydney' },
  { slug: 'fra1', name: '🇩🇪 Frankfurt' },
  { slug: 'ams3', name: '🇳🇱 Amsterdam' },
  { slug: 'lon1', name: '🇬🇧 London' },
  { slug: 'nyc1', name: '🇺🇸 New York' },
  { slug: 'nyc3', name: '🇺🇸 New York 3' },
  { slug: 'sfo3', name: '🇺🇸 San Francisco' },
  { slug: 'tor1', name: '🇨🇦 Toronto' }
];

/**
 * Ukuran droplet (paket "Basic" reguler). `ram` dipakai untuk menandai
 * kecocokan dengan RDP Windows. `priceUsd` hanya info perkiraan ke buyer.
 */
const DO_SIZES = [
  { slug: 's-1vcpu-512mb-10gb', name: '1 vCPU · 512MB · 10GB SSD', ram: 0.5, priceUsd: 4 },
  { slug: 's-1vcpu-1gb',        name: '1 vCPU · 1GB · 25GB SSD',   ram: 1,   priceUsd: 6 },
  { slug: 's-1vcpu-2gb',        name: '1 vCPU · 2GB · 50GB SSD',   ram: 2,   priceUsd: 12 },
  { slug: 's-2vcpu-2gb',        name: '2 vCPU · 2GB · 60GB SSD',   ram: 2,   priceUsd: 18 },
  { slug: 's-2vcpu-4gb',        name: '2 vCPU · 4GB · 80GB SSD',   ram: 4,   priceUsd: 24 },
  { slug: 's-4vcpu-8gb',        name: '4 vCPU · 8GB · 160GB SSD',  ram: 8,   priceUsd: 48 }
];

/** Image OS. Default Ubuntu 22.04 — paling cocok kalau nanti dipasang RDP. */
const DO_IMAGES = [
  { slug: 'ubuntu-22-04-x64', name: 'Ubuntu 22.04 LTS' },
  { slug: 'ubuntu-24-04-x64', name: 'Ubuntu 24.04 LTS' },
  { slug: 'ubuntu-20-04-x64', name: 'Ubuntu 20.04 LTS' },
  { slug: 'debian-12-x64',    name: 'Debian 12' }
];

const findRegion = (slug) => DO_REGIONS.find((r) => r.slug === slug) || null;
const findSize = (slug) => DO_SIZES.find((s) => s.slug === slug) || null;
const findImage = (slug) => DO_IMAGES.find((i) => i.slug === slug) || null;

function client(token) {
  return axios.create({
    baseURL: API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
}

/**
 * Ubah error axios/DigitalOcean jadi pesan berkode yang bisa dibedakan di UI.
 * Formatnya "KODE:penjelasan", sama polanya dengan util SSH.
 */
function describeError(error) {
  if (error && error.response) {
    const status = error.response.status;
    const data = error.response.data || {};
    const msg = data.message || data.id || '';
    if (status === 401) return 'DO_AUTH:Token DigitalOcean tidak valid atau sudah dicabut.';
    if (status === 403) return 'DO_FORBIDDEN:Token tidak punya izin menulis (butuh scope "write"), atau akun belum diverifikasi.';
    if (status === 404) return 'DO_NOTFOUND:Resource tidak ditemukan di DigitalOcean.';
    if (status === 422) return `DO_INVALID:${msg || 'Parameter droplet ditolak DigitalOcean.'}`;
    if (status === 429) return 'DO_RATELIMIT:Terlalu banyak permintaan ke DigitalOcean. Tunggu sebentar lalu coba lagi.';
    return `DO_HTTP_${status}:${msg || 'Permintaan ke DigitalOcean gagal.'}`;
  }
  if (error && error.code === 'ECONNABORTED') {
    return 'DO_TIMEOUT:DigitalOcean tidak merespons tepat waktu.';
  }
  return `DO_NETWORK:${(error && error.message) || 'Gagal menghubungi DigitalOcean.'}`;
}

/**
 * Validasi token dengan memanggil endpoint akun.
 * @returns {Promise<{ok:boolean, email?:string, status?:string, error?:string}>}
 */
async function validateToken(token) {
  try {
    const res = await client(token).get('/account');
    const acc = (res.data && res.data.account) || {};
    return { ok: true, email: acc.email, status: acc.status };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Buat password acak yang MEMENUHI aturan VPS (utils/password.js):
 * mengandung simbol, huruf besar, huruf kecil, dan angka, serta diakhiri huruf.
 * Semua karakter berada di dalam set yang aman untuk YAML cloud-init.
 */
function genPassword(length = 16) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#%^&*_-+=.?';
  const letters = upper + lower;
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];

  // Jamin tiap kategori muncul di bagian tubuh (bukan karakter terakhir).
  const body = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const bodyLen = Math.max(4, length - 1);
  while (body.length < bodyLen) body.push(pick(all));

  // Acak urutan tubuh, lalu tempel HURUF di akhir (aturan: diakhiri huruf).
  const shuffled = body.sort(() => Math.random() - 0.5).join('');
  return shuffled + pick(letters);
}

/**
 * cloud-init untuk memasang password root yang KITA tentukan.
 *
 * Kenapa perlu: DigitalOcean tidak pernah mengembalikan password root lewat
 * API. Droplet tanpa SSH key malah mengirim password acak ke EMAIL pemilik akun
 * — tidak bisa dibaca bot. Jadi kita set sendiri password root lewat cloud-init
 * dan sekalian memastikan login password + root diizinkan (beberapa image DO
 * mematikannya secara default lewat file di sshd_config.d/).
 */
function buildCloudInit(rootPassword) {
  return [
    '#cloud-config',
    'disable_root: false',
    'ssh_pwauth: true',
    'chpasswd:',
    '  expire: false',
    '  list: |',
    `    root:${rootPassword}`,
    'runcmd:',
    "  - sed -ri 's/^#?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config",
    "  - sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config",
    '  - bash -c \'for f in /etc/ssh/sshd_config.d/*.conf; do [ -e "$f" ] && sed -ri "s/^#?PasswordAuthentication.*/PasswordAuthentication yes/; s/^#?PermitRootLogin.*/PermitRootLogin yes/" "$f"; done\'',
    '  - bash -c \'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true\'',
    ''
  ].join('\n');
}

/**
 * Buat satu atau beberapa droplet sekaligus.
 *
 * Selalu memakai field `names` (array), meski cuma satu — DigitalOcean lalu
 * membalas dengan array `droplets`. Ini yang membuat "buat 1-10 sekaligus"
 * cukup satu panggilan API.
 *
 * @returns {Promise<Array<{id:number,name:string,status:string}>>}
 */
async function createDroplets({ token, names, region, size, image, rootPassword }) {
  const body = {
    names,
    region,
    size,
    image,
    backups: false,
    ipv6: true,
    monitoring: false,
    user_data: buildCloudInit(rootPassword),
    tags: ['rdpbot']
  };

  const res = await client(token).post('/droplets', body);
  const data = res.data || {};
  const droplets = data.droplets || (data.droplet ? [data.droplet] : []);
  return droplets.map((d) => ({ id: d.id, name: d.name, status: d.status }));
}

/** Ambil detail satu droplet. */
async function getDroplet(token, id) {
  const res = await client(token).get(`/droplets/${id}`);
  return (res.data && res.data.droplet) || null;
}

/** Ambil IPv4 publik dari objek droplet (null kalau belum diberikan). */
function publicIpv4(droplet) {
  const v4 = (droplet && droplet.networks && droplet.networks.v4) || [];
  const pub = v4.find((n) => n.type === 'public');
  return pub ? pub.ip_address : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tunggu droplet aktif dan mendapat IP publik.
 *
 * Droplet baru butuh ~40-90 detik untuk boot dan mendapat IP. Fungsi ini
 * mem-polling tiap 6 detik sampai semua dapat IP atau batas waktu lewat.
 * `onTick` dipanggil tiap siklus untuk memperbarui tampilan progres.
 *
 * @returns {Promise<Array<{id:number,name:?string,ip:?string,status:string}>>}
 */
async function waitForDroplets({ token, ids, onTick, timeoutMs = 3 * 60 * 1000 }) {
  const started = Date.now();
  const results = new Map(ids.map((id) => [id, { id, name: null, ip: null, status: 'new' }]));

  while (Date.now() - started < timeoutMs) {
    for (const id of ids) {
      const cur = results.get(id);
      if (cur.ip) continue;
      try {
        const d = await getDroplet(token, id);
        if (d) {
          cur.status = d.status;
          cur.name = d.name;
          const ip = publicIpv4(d);
          if (d.status === 'active' && ip) cur.ip = ip;
        }
      } catch (_) {
        // Gangguan sesaat — coba lagi di siklus berikutnya.
      }
    }

    const list = [...results.values()];
    if (onTick) { try { onTick(list); } catch (_) {} }
    if (list.every((r) => r.ip)) break;

    await sleep(6000);
  }

  return [...results.values()];
}

module.exports = {
  DO_REGIONS,
  DO_SIZES,
  DO_IMAGES,
  findRegion,
  findSize,
  findImage,
  validateToken,
  createDroplets,
  getDroplet,
  publicIpv4,
  waitForDroplets,
  buildCloudInit,
  genPassword,
  describeError
};
