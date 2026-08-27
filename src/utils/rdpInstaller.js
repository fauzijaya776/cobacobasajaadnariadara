const ssh = require('./ssh');
const { recommendedSwapGb } = require('./specFormatter');

/**
 * Base URL script installer. Dibuat bisa diganti lewat .env supaya kalau domain
 * berubah/mati, tidak perlu ubah kode.
 */
const SCRIPT_BASE = (process.env.RDP_SCRIPT_BASE || 'https://reemote.biz.id').replace(/\/+$/, '');

const REMOTE_DIR = '/root/.rdpbot';
const LOG_FILE = `${REMOTE_DIR}/install.log`;
const STATUS_FILE = `${REMOTE_DIR}/install.status`;
const PID_FILE = `${REMOTE_DIR}/install.pid`;

/** Pilih script sesuai arsitektur dan dukungan KVM. */
function resolveScriptUrl({ isArm, supportsKvm }) {
  let name;
  if (isArm) {
    name = supportsKvm ? 'arm.sh' : 'armn.sh';
  } else {
    name = supportsKvm ? 'rdp.sh' : 'rdpn.sh';
  }
  return `${SCRIPT_BASE}/${name}`;
}

/**
 * Perintah persiapan host, dijalankan SEBELUM installer.
 *
 * Tiga hal yang dikerjakan:
 *  1. Menunggu lock apt lepas — VPS yang baru dibuat masih menjalankan
 *     cloud-init/unattended-upgrades, dan itu penyebab umum instalasi gagal
 *     di menit-menit pertama.
 *  2. Membuat swap file + mengaktifkan memory overcommit. Ini yang membuat
 *     alokasi RAM PENUH ke Windows tetap aman: saat puncak instalasi, kebutuhan
 *     host + overhead QEMU melebihi RAM fisik, dan tanpa swap OOM killer akan
 *     mematikan QEMU di tengah jalan.
 *  3. Mengunduh script installer dengan verifikasi — kalau server membalas
 *     halaman HTML error dengan status 200, file itu ditolak alih-alih
 *     dieksekusi sebagai shell script.
 */
function buildPrepareCommand({ scriptUrl, swapGb }) {
  return `
export DEBIAN_FRONTEND=noninteractive
mkdir -p ${REMOTE_DIR}
rm -f ${STATUS_FILE} ${PID_FILE} ${LOG_FILE}

# --- 1. Tunggu apt/dpkg lock lepas (maks ~180 detik) ---
LOCK_WAITED=0
for i in $(seq 1 60); do
  BUSY=0
  for L in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock; do
    if command -v fuser >/dev/null 2>&1; then
      fuser "$L" >/dev/null 2>&1 && BUSY=1
    fi
  done
  pgrep -x apt >/dev/null 2>&1 && BUSY=1
  pgrep -x apt-get >/dev/null 2>&1 && BUSY=1
  pgrep -f unattended-upgr >/dev/null 2>&1 && BUSY=1
  [ "$BUSY" = "0" ] && break
  LOCK_WAITED=$((LOCK_WAITED+3))
  sleep 3
done
echo "LOCK_WAITED=$LOCK_WAITED"

# --- 2. Swap + overcommit (bantalan agar RAM bisa dialokasikan penuh) ---
SWAP_ACTIVE=$(swapon --show=NAME --noheadings 2>/dev/null | wc -l)
if [ "$SWAP_ACTIVE" -eq 0 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l ${swapGb}G /swapfile 2>/dev/null || \\
      dd if=/dev/zero of=/swapfile bs=1M count=$((${swapGb}*1024)) status=none 2>/dev/null
  fi
  chmod 600 /swapfile 2>/dev/null
  mkswap /swapfile >/dev/null 2>&1
  swapon /swapfile >/dev/null 2>&1
  grep -q '^/swapfile' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null 2>&1
sysctl -w vm.overcommit_memory=1 >/dev/null 2>&1
SWAP_MB=$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}')
echo "SWAP_MB=$SWAP_MB"

# --- 3. Unduh script installer ---
DL_TOOL=none
if command -v curl >/dev/null 2>&1; then
  DL_TOOL=curl
elif command -v wget >/dev/null 2>&1; then
  DL_TOOL=wget
else
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq curl >/dev/null 2>&1
  command -v curl >/dev/null 2>&1 && DL_TOOL=curl
fi
echo "DL_TOOL=$DL_TOOL"

DL_OK=0
if [ "$DL_TOOL" = "curl" ]; then
  curl -fsSL --retry 3 --retry-delay 2 --max-time 180 -o ${REMOTE_DIR}/rdp.sh "${scriptUrl}" && DL_OK=1
elif [ "$DL_TOOL" = "wget" ]; then
  wget -q --tries=3 --timeout=180 -O ${REMOTE_DIR}/rdp.sh "${scriptUrl}" && DL_OK=1
fi

if [ "$DL_OK" != "1" ] || [ ! -s ${REMOTE_DIR}/rdp.sh ]; then
  echo "PREP_ERROR=DOWNLOAD_FAILED"
  echo "PREP_DONE=1"
  exit 0
fi

# Tolak kalau yang terunduh ternyata halaman HTML (server balas 200 tapi isinya error page).
if head -c 1024 ${REMOTE_DIR}/rdp.sh | grep -qiE '<(!doctype|html|head|body|title)'; then
  echo "PREP_ERROR=DOWNLOAD_HTML"
  echo "PREP_DONE=1"
  exit 0
fi

SCRIPT_SIZE=$(wc -c < ${REMOTE_DIR}/rdp.sh)
if [ "$SCRIPT_SIZE" -lt 100 ]; then
  echo "PREP_ERROR=SCRIPT_TOO_SMALL"
  echo "PREP_DONE=1"
  exit 0
fi
echo "SCRIPT_SIZE=$SCRIPT_SIZE"

chmod +x ${REMOTE_DIR}/rdp.sh
echo "PREP_ERROR=NONE"
echo "PREP_DONE=1"
`.trim();
}

/**
 * Perintah untuk menjalankan installer secara DETACHED.
 *
 * Versi lama menahan satu channel SSH terbuka selama 10-60 menit dan memakai
 * exit code stream sebagai penentu sukses. Dua masalah:
 *  - Koneksi idle diputus / VPS reboot -> dilaporkan gagal padahal sukses.
 *  - Exit code yang terbaca sebenarnya milik `rm -f rdp.sh` (perintah terakhir),
 *    bukan milik installer -> laporan sukses/gagal palsu.
 *
 * Sekarang installer dijalankan lepas dari sesi SSH, dan exit code aslinya
 * ditulis ke file status. Bot tinggal membaca file itu, jadi putusnya koneksi
 * atau reboot tidak lagi merusak pelaporan.
 */
function buildLaunchCommand({ windowsId, ram, cpu, storage, password }) {
  // Heredoc dikutip ('INPUT_EOF') supaya isi input TIDAK diekspansi shell.
  // Tanpa kutip, karakter $ dan backtick di password akan berubah diam-diam.
  return `
mkdir -p ${REMOTE_DIR}

cat > ${REMOTE_DIR}/answers.txt << 'INPUT_EOF'
${windowsId}
${ram}
${cpu}
${storage}
${password}
INPUT_EOF

cat > ${REMOTE_DIR}/run.sh << 'RUN_EOF'
#!/bin/bash
cd /root
bash ${REMOTE_DIR}/rdp.sh < ${REMOTE_DIR}/answers.txt >> ${LOG_FILE} 2>&1
RC=$?
echo "INSTALL_EXIT=$RC" > ${STATUS_FILE}
rm -f ${REMOTE_DIR}/answers.txt
RUN_EOF

chmod +x ${REMOTE_DIR}/run.sh
touch ${LOG_FILE}

# setsid + nohup: proses tetap hidup walau sesi SSH ditutup.
setsid nohup bash ${REMOTE_DIR}/run.sh > /dev/null 2>&1 &
echo $! > ${PID_FILE}
sleep 2

LAUNCH_PID=$(cat ${PID_FILE} 2>/dev/null)
if kill -0 "$LAUNCH_PID" 2>/dev/null; then
  echo "LAUNCH=OK"
else
  # Proses sudah selesai dalam 2 detik: kemungkinan gagal seketika.
  if [ -f ${STATUS_FILE} ]; then
    echo "LAUNCH=FINISHED_EARLY"
  else
    echo "LAUNCH=FAILED"
  fi
fi
echo "LAUNCH_DONE=1"
`.trim();
}

const POLL_COMMAND = `
if [ -f ${STATUS_FILE} ]; then
  echo "STATE=DONE"
  cat ${STATUS_FILE}
else
  PID=$(cat ${PID_FILE} 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "STATE=RUNNING"
  elif pgrep -f '${REMOTE_DIR}/rdp.sh' >/dev/null 2>&1; then
    echo "STATE=RUNNING"
  else
    echo "STATE=GONE"
  fi
fi
echo "LOG_LINES=$(wc -l < ${LOG_FILE} 2>/dev/null || echo 0)"
echo "---LOGTAIL---"
tail -n 6 ${LOG_FILE} 2>/dev/null
`.trim();

/**
 * Jalankan instalasi dari awal sampai selesai.
 *
 * @param {object} target { host, port, username, password }
 * @param {object} config { windowsId, cpu, ram, storage, password, isArm, supportsKvm }
 * @param {object} hooks  { onLog, onProgress }
 */
async function installRDP(target, config, hooks = {}) {
  const { onLog, onProgress } = hooks;
  const scriptUrl = resolveScriptUrl(config);
  const swapGb = config.swap || recommendedSwapGb(config.ram);

  const log = (msg) => { if (onLog) onLog(msg); };

  /* ---------- Tahap 1: persiapan host + unduh script ---------- */
  if (onProgress) onProgress({ phase: 'prepare', percent: 5, note: 'Menyiapkan VPS' });

  let conn = await ssh.connect(target);
  let prep;
  try {
    prep = await ssh.exec(conn, buildPrepareCommand({ scriptUrl, swapGb }), {
      onLog: log,
      timeoutMs: 15 * 60 * 1000
    });
  } finally {
    try { conn.end(); } catch (_) {}
  }

  if (!ssh.readField(prep.stdout, 'PREP_DONE')) {
    throw new Error('PREP_INCOMPLETE:Persiapan VPS tidak selesai');
  }

  const prepError = ssh.readField(prep.stdout, 'PREP_ERROR');
  if (prepError && prepError !== 'NONE') {
    throw new Error(`PREP_${prepError}:${describePrepError(prepError, scriptUrl)}`);
  }

  const swapMb = parseInt(ssh.readField(prep.stdout, 'SWAP_MB') || '0', 10);
  log(`[prep] swap aktif: ${swapMb} MB, script: ${scriptUrl}\n`);

  /* ---------- Tahap 2: jalankan installer secara detached ---------- */
  if (onProgress) onProgress({ phase: 'launch', percent: 10, note: 'Memulai instalasi' });

  conn = await ssh.connect(target);
  let launch;
  try {
    launch = await ssh.exec(conn, buildLaunchCommand(config), {
      onLog: log,
      timeoutMs: 2 * 60 * 1000
    });
  } finally {
    try { conn.end(); } catch (_) {}
  }

  const launchState = ssh.readField(launch.stdout, 'LAUNCH');
  if (launchState === 'FAILED') {
    throw new Error('LAUNCH_FAILED:Installer gagal dijalankan di VPS');
  }

  /* ---------- Tahap 3: polling sampai selesai ---------- */
  return await waitForCompletion(target, { onLog, onProgress });
}

function describePrepError(code, scriptUrl) {
  switch (code) {
    case 'DOWNLOAD_FAILED':
      return `VPS tidak bisa mengunduh script installer dari ${scriptUrl}. Cek koneksi keluar VPS atau ketersediaan server script.`;
    case 'DOWNLOAD_HTML':
      return `URL script (${scriptUrl}) membalas halaman web, bukan script. Kemungkinan URL salah atau server sedang bermasalah.`;
    case 'SCRIPT_TOO_SMALL':
      return 'File script yang terunduh tidak wajar (terlalu kecil).';
    default:
      return 'Persiapan VPS gagal.';
  }
}

/**
 * Polling status instalasi dengan koneksi SSH baru tiap siklus.
 * Koneksi yang putus atau VPS yang reboot tidak dianggap gagal — selama
 * file status belum ada dan batas waktu belum lewat, polling dilanjutkan.
 */
async function waitForCompletion(target, { onLog, onProgress } = {}) {
  const POLL_INTERVAL_MS = 20000;
  const MAX_DURATION_MS = 90 * 60 * 1000; // 90 menit
  const MAX_CONSECUTIVE_ERRORS = 30;      // ~10 menit VPS tidak bisa dihubungi

  const startedAt = Date.now();
  let consecutiveErrors = 0;
  let lastLogLines = 0;
  let sawRunning = false;

  while (Date.now() - startedAt < MAX_DURATION_MS) {
    await sleep(POLL_INTERVAL_MS);

    let result;
    try {
      result = await ssh.execOnce(target, POLL_COMMAND, { timeoutMs: 60000 });
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      // VPS sedang reboot / koneksi putus sementara — ini normal saat instalasi.
      if (onLog) onLog(`[poll] VPS belum bisa dihubungi (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})\n`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error('VPS_UNREACHABLE:VPS tidak bisa dihubungi terlalu lama saat instalasi');
      }
      continue;
    }

    const state = ssh.readField(result.stdout, 'STATE');
    const logLines = parseInt(ssh.readField(result.stdout, 'LOG_LINES') || '0', 10);

    if (logLines > lastLogLines) {
      const tail = result.stdout.split('---LOGTAIL---')[1];
      if (tail && onLog) onLog(tail.trim() + '\n');
      lastLogLines = logLines;
    }

    if (onProgress) {
      const elapsedMin = Math.floor((Date.now() - startedAt) / 60000);
      // Progress berbasis waktu berjalan, dibatasi 95% sampai benar-benar selesai.
      const percent = Math.min(95, 10 + Math.floor((elapsedMin / 45) * 85));
      onProgress({ phase: 'installing', percent, note: `Berjalan ${elapsedMin} menit`, logLines });
    }

    if (state === 'RUNNING') {
      sawRunning = true;
      continue;
    }

    if (state === 'DONE') {
      const exitCode = parseInt(ssh.readField(result.stdout, 'INSTALL_EXIT') || '-1', 10);
      if (exitCode === 0) {
        if (onProgress) onProgress({ phase: 'done', percent: 100, note: 'Selesai' });
        return { success: true, exitCode, durationMs: Date.now() - startedAt };
      }
      const tail = (result.stdout.split('---LOGTAIL---')[1] || '').trim();
      throw new Error(
        `INSTALL_FAILED:Script installer berhenti dengan kode ${exitCode}` +
        (tail ? `\n\nLog terakhir:\n${tail.slice(-400)}` : '')
      );
    }

    if (state === 'GONE') {
      // Proses hilang tanpa menulis file status.
      // Kalau sebelumnya sempat terlihat berjalan, kemungkinan besar VPS reboot
      // (perilaku normal sebagian installer) — beri kesempatan reconnect.
      if (sawRunning && Date.now() - startedAt < 10 * 60 * 1000) {
        if (onLog) onLog('[poll] Proses hilang, kemungkinan VPS reboot. Menunggu...\n');
        sawRunning = false;
        continue;
      }
      throw new Error('INSTALL_VANISHED:Proses instalasi berhenti tanpa menulis status (kemungkinan kehabisan memori atau disk)');
    }
  }

  throw new Error('INSTALL_TIMEOUT:Instalasi melewati batas waktu 90 menit');
}

/** Cek apakah layanan RDP/viewer sudah hidup. Dipakai untuk verifikasi akhir. */
async function verifyServices(host, ports = [8006, 3389], timeoutMs = 5000) {
  const results = await Promise.all(
    ports.map(async (port) => ({
      port,
      open: await ssh.probeTcpPort(host, port, timeoutMs).catch(() => false)
    }))
  );
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  installRDP,
  waitForCompletion,
  resolveScriptUrl,
  verifyServices,
  buildPrepareCommand,
  buildLaunchCommand,
  SCRIPT_BASE
};
