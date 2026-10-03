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
    return {
      ok: true,
      email: acc.email,
      status: acc.status,
      dropletLimit: acc.droplet_limit != null ? Number(acc.droplet_limit) : null,
      scoped: false
    };
  } catch (error) {
    // Token "custom scope" boleh tidak punya izin baca akun (403) tapi tetap
    // bisa mengelola droplet. Coba sekali lagi lewat /droplets sebelum menolak.
    const status = error && error.response && error.response.status;
    if (status === 403) {
      try {
        await client(token).get('/droplets', { params: { per_page: 1 } });
        return { ok: true, email: null, status: null, dropletLimit: null, scoped: true };
      } catch (_) { /* tetap ditolak */ }
    }
    return { ok: false, error: describeError(error) };
  }
}

/* ============================================================
 * Control DigitalOcean — daftar, detail, aksi, hapus, tagihan
 * ============================================================ */

/** Ringkas objek droplet mentah jadi field yang dipakai tampilan bot. */
function shapeDroplet(d) {
  if (!d) return null;
  const size = d.size || {};
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    ip: publicIpv4(d),
    region: d.region ? (d.region.name || d.region.slug) : '-',
    regionSlug: d.region ? d.region.slug : null,
    sizeSlug: d.size_slug || size.slug || '-',
    vcpus: d.vcpus,
    memoryMb: d.memory,
    diskGb: d.disk,
    priceMonthly: size.price_monthly != null ? Number(size.price_monthly) : null,
    image: d.image ? `${d.image.distribution || ''} ${d.image.name || ''}`.trim() : '-',
    createdAt: d.created_at,
    locked: !!d.locked,
    tags: d.tags || [],
    features: d.features || [],
    backupIds: d.backup_ids || [],
    snapshotIds: d.snapshot_ids || [],
    nextBackup: d.next_backup_window ? d.next_backup_window.start : null,
    ipv6: ((d.networks && d.networks.v6) || []).map((n) => n.ip_address)[0] || null,
    privateIp: (((d.networks && d.networks.v4) || []).find((n) => n.type === 'private') || {}).ip_address || null
  };
}

/** Daftar droplet (satu halaman). */
async function listDroplets(token, { page = 1, perPage = 8 } = {}) {
  const res = await client(token).get('/droplets', { params: { page, per_page: perPage } });
  const data = res.data || {};
  const total = (data.meta && Number(data.meta.total)) || (data.droplets || []).length;
  return { droplets: (data.droplets || []).map(shapeDroplet), total };
}

/** Detail satu droplet dalam bentuk ringkas. */
async function getDropletInfo(token, id) {
  return shapeDroplet(await getDroplet(token, id));
}

/** Aksi yang boleh dijalankan dari bot. Kunci pendek dipakai di callback_data. */
const DROPLET_ACTIONS = {
  on:      { type: 'power_on',       label: 'Menyalakan droplet' },
  off:     { type: 'shutdown',       label: 'Mematikan droplet (shutdown)' },
  kill:    { type: 'power_off',      label: 'Mematikan paksa droplet' },
  reboot:  { type: 'reboot',         label: 'Reboot droplet' },
  cycle:   { type: 'power_cycle',    label: 'Power cycle droplet' },
  pwreset: { type: 'password_reset', label: 'Reset password root' },
  snap:    { type: 'snapshot',       label: 'Membuat snapshot' }
};

async function dropletAction(token, id, key) {
  const def = DROPLET_ACTIONS[key];
  if (!def) throw new Error('DO_INVALID:Aksi tidak dikenal.');
  const body = { type: def.type };
  if (def.type === 'snapshot') {
    body.name = `snap-${id}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  }
  const res = await client(token).post(`/droplets/${id}/actions`, body);
  return (res.data && res.data.action) || null;
}

/**
 * Aksi droplet yang butuh parameter (dipakai website). Body sesuai dokumentasi
 * DigitalOcean "Droplet Actions":
 *   resize {size, disk}, rebuild {image}, rename {name}, restore {image},
 *   snapshot {name}, enable_backups, disable_backups, enable_ipv6, dan aksi daya.
 */
const ACTION_TYPES = new Set([
  'power_on', 'shutdown', 'power_off', 'reboot', 'power_cycle', 'password_reset',
  'snapshot', 'resize', 'rebuild', 'rename', 'restore', 'enable_backups', 'disable_backups', 'enable_ipv6'
]);

async function dropletActionRaw(token, id, body) {
  if (!body || !ACTION_TYPES.has(body.type)) throw new Error('DO_INVALID:Aksi tidak dikenal.');
  const res = await client(token).post(`/droplets/${id}/actions`, body);
  return (res.data && res.data.action) || null;
}

/** Riwayat aksi droplet (terbaru dulu). */
async function listDropletActions(token, id) {
  const res = await client(token).get(`/droplets/${id}/actions`, { params: { per_page: 20 } });
  return ((res.data && res.data.actions) || []).map((a) => ({
    id: a.id, type: a.type, status: a.status, startedAt: a.started_at, completedAt: a.completed_at
  }));
}

/** Snapshot & backup milik satu droplet (bisa dipakai untuk restore/rebuild). */
async function listDropletImages(token, id) {
  const c = client(token);
  const [snap, back] = await Promise.all([
    c.get(`/droplets/${id}/snapshots`, { params: { per_page: 50 } }),
    c.get(`/droplets/${id}/backups`, { params: { per_page: 50 } }).catch(() => ({ data: {} }))
  ]);
  const shape = (kind) => (i) => ({ id: i.id, name: i.name, kind, sizeGb: i.size_gigabytes, createdAt: i.created_at });
  return [
    ...((snap.data && snap.data.snapshots) || []).map(shape('snapshot')),
    ...((back.data && back.data.backups) || []).map(shape('backup'))
  ];
}

/** Semua snapshot droplet di akun (untuk halaman kelola snapshot). */
async function listSnapshots(token) {
  const res = await client(token).get('/snapshots', { params: { resource_type: 'droplet', per_page: 100 } });
  return ((res.data && res.data.snapshots) || []).map((s) => ({
    id: s.id, name: s.name, sizeGb: s.size_gigabytes, minDiskGb: s.min_disk_size,
    regions: s.regions || [], createdAt: s.created_at, resourceId: s.resource_id
  }));
}

async function deleteSnapshot(token, id) {
  await client(token).delete(`/snapshots/${id}`);
  return true;
}

/** Ukuran droplet yang tersedia (live dari DigitalOcean). */
async function listSizes(token) {
  const res = await client(token).get('/sizes', { params: { per_page: 200 } });
  return ((res.data && res.data.sizes) || []).filter((s) => s.available).map((s) => ({
    slug: s.slug, vcpus: s.vcpus, memoryMb: s.memory, diskGb: s.disk,
    priceMonthly: s.price_monthly, regions: s.regions || [], description: s.description || ''
  }));
}

/* ---------- SSH key akun DigitalOcean ---------- */
async function listSshKeys(token) {
  const res = await client(token).get('/account/keys', { params: { per_page: 200 } });
  return ((res.data && res.data.ssh_keys) || []).map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint }));
}

async function addSshKey(token, name, publicKey) {
  const res = await client(token).post('/account/keys', { name, public_key: publicKey });
  const k = (res.data && res.data.ssh_key) || {};
  return { id: k.id, name: k.name, fingerprint: k.fingerprint };
}

async function deleteSshKey(token, id) {
  await client(token).delete(`/account/keys/${id}`);
  return true;
}

/**
 * Gabungkan cloud-init bawaan (password root) dengan cloud-init / script milik
 * user. DigitalOcean hanya menerima SATU user_data, jadi keduanya dibungkus
 * MIME multipart — format resmi cloud-init untuk banyak bagian. Header
 * Merge-Type membuat runcmd/packages milik user DITAMBAHKAN, bukan menimpa
 * pengaturan password root.
 */
function combineUserData(rootPassword, custom) {
  const base = buildCloudInit(rootPassword);
  const extra = String(custom || '').replace(/\r\n/g, '\n').trim();
  if (!extra) return base;
  const isScript = extra.startsWith('#!');
  const boundary = `==RDPBOT${Date.now().toString(36)}==`;
  return [
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    'MIME-Version: 1.0',
    '',
    '--' + boundary,
    'Content-Type: text/cloud-config; charset="utf-8"',
    '',
    base,
    '--' + boundary,
    `Content-Type: ${isScript ? 'text/x-shellscript' : 'text/cloud-config'}; charset="utf-8"`,
    ...(isScript ? [] : ['Merge-Type: list(append)+dict(no_replace,recurse_list)+str()']),
    '',
    extra,
    '--' + boundary + '--',
    ''
  ].join('\n');
}

async function deleteDroplet(token, id) {
  await client(token).delete(`/droplets/${id}`);
  return true;
}

/** Pemakaian bulan berjalan. null kalau token tidak punya izin billing. */
async function getBalance(token) {
  try {
    const res = await client(token).get('/customers/my/balance');
    const b = res.data || {};
    return {
      monthToDateUsage: b.month_to_date_usage != null ? Number(b.month_to_date_usage) : null,
      accountBalance: b.account_balance != null ? Number(b.account_balance) : null
    };
  } catch (_) {
    return null;
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
async function createDroplets({
  token, names, region, size, image, rootPassword,
  userData = '', sshKeys = [], backups = false, monitoring = false, ipv6 = true, tags = []
}) {
  const body = {
    names,
    region,
    size,
    image,
    backups: !!backups,
    ipv6: !!ipv6,
    monitoring: !!monitoring,
    ssh_keys: sshKeys,
    user_data: combineUserData(rootPassword, userData),
    tags: ['rdpbot', ...tags]
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
  getDropletInfo,
  listDroplets,
  dropletAction,
  deleteDroplet,
  dropletActionRaw,
  listDropletActions,
  listDropletImages,
  listSnapshots,
  deleteSnapshot,
  listSizes,
  listSshKeys,
  addSshKey,
  deleteSshKey,
  combineUserData,
  getBalance,
  DROPLET_ACTIONS,
  publicIpv4,
  waitForDroplets,
  buildCloudInit,
  genPassword,
  describeError
};
