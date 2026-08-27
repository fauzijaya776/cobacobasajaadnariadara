const ssh = require('./ssh');
const { roundUpSpecs } = require('./specFormatter');

/**
 * Perintah deteksi dibuat toleran terhadap perbedaan distro:
 *  - `df --output` tidak ada di coreutils lama/busybox, jadi ada fallback ke df -P.
 *  - Disk yang dipakai adalah filesystem tempat Docker menyimpan data (/var/lib/docker
 *    kalau ada, kalau tidak ya /), karena di situlah image Windows akan ditulis.
 *  - Semua nilai dikeluarkan sebagai KEY=value agar bisa diparse tanpa menebak.
 */
const DETECT_COMMAND = `
CPU=$(nproc 2>/dev/null | head -n1)
[ -z "$CPU" ] && CPU=$(grep -c ^processor /proc/cpuinfo 2>/dev/null | head -n1)
[ -z "$CPU" ] && CPU=1
RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}')

DOCKER_DIR=/var/lib/docker
[ -d "$DOCKER_DIR" ] || DOCKER_DIR=/

DF_LINE=$(df -P -k "$DOCKER_DIR" 2>/dev/null | tail -1)
DISK_TOTAL_K=$(echo "$DF_LINE" | awk '{print $2}')
DISK_AVAIL_K=$(echo "$DF_LINE" | awk '{print $4}')

ARCH=$(uname -m)
KERNEL=$(uname -r)

OS_ID=$( (. /etc/os-release 2>/dev/null && echo "$ID") || echo unknown)
OS_VER=$( (. /etc/os-release 2>/dev/null && echo "$VERSION_ID") || echo unknown)

# systemd-detect-virt mencetak 'none' DAN keluar dengan status 1 di bare metal,
# sehingga '|| echo unknown' ikut jalan dan menghasilkan dua baris.
VIRT=$(systemd-detect-virt 2>/dev/null | head -n1)
[ -z "$VIRT" ] && VIRT=unknown
KVM_DEV=$([ -e /dev/kvm ] && echo yes || echo no)
CPU_VIRT=$(grep -Ec '(vmx|svm)' /proc/cpuinfo 2>/dev/null | head -n1)
[ -z "$CPU_VIRT" ] && CPU_VIRT=0

echo "CPU=$CPU"
echo "RAM_MB=$RAM_MB"
echo "DISK_TOTAL_K=$DISK_TOTAL_K"
echo "DISK_AVAIL_K=$DISK_AVAIL_K"
echo "ARCH=$ARCH"
echo "KERNEL=$KERNEL"
echo "OS_ID=$OS_ID"
echo "OS_VER=$OS_VER"
echo "VIRT=$VIRT"
echo "KVM_DEV=$KVM_DEV"
echo "CPU_VIRT=$CPU_VIRT"
echo "DETECT_DONE=1"
`.trim();

/**
 * Deteksi spesifikasi VPS.
 * Bisa memakai koneksi SSH yang sudah ada (agar tidak membuka koneksi ganda).
 */
async function detectVPSSpecs(hostOrConn, username, password, port = 22) {
  const usingExistingConn =
    hostOrConn && typeof hostOrConn === 'object' && typeof hostOrConn.exec === 'function';

  let result;
  if (usingExistingConn) {
    result = await ssh.exec(hostOrConn, DETECT_COMMAND, { timeoutMs: 60000 });
  } else {
    result = await ssh.execOnce(
      { host: hostOrConn, port, username, password },
      DETECT_COMMAND,
      { timeoutMs: 60000 }
    );
  }

  return parseSpecs(result.stdout);
}

function parseSpecs(output) {
  if (!ssh.readField(output, 'DETECT_DONE')) {
    throw new Error('SPEC_INCOMPLETE:Deteksi spesifikasi tidak selesai');
  }

  const cpu = parseFloat(ssh.readField(output, 'CPU'));
  const ramMb = parseFloat(ssh.readField(output, 'RAM_MB'));
  const diskTotalK = parseFloat(ssh.readField(output, 'DISK_TOTAL_K'));
  const diskAvailK = parseFloat(ssh.readField(output, 'DISK_AVAIL_K'));

  if (!Number.isFinite(cpu) || !Number.isFinite(ramMb) || !Number.isFinite(diskAvailK)) {
    throw new Error('SPEC_PARSE:Gagal membaca spesifikasi VPS');
  }

  const arch = ssh.readField(output, 'ARCH') || 'unknown';
  const raw = {
    cpu,
    ram: ramMb / 1024,
    storage: diskTotalK / 1024 / 1024,
    storageAvail: diskAvailK / 1024 / 1024,
    arch,
    isArm: /^(aarch64|arm64|armv[78])/i.test(arch),
    kernel: ssh.readField(output, 'KERNEL') || 'unknown',
    osId: (ssh.readField(output, 'OS_ID') || 'unknown').replace(/"/g, ''),
    osVersion: (ssh.readField(output, 'OS_VER') || 'unknown').replace(/"/g, ''),
    virt: ssh.readField(output, 'VIRT') || 'unknown',
    hasKvmDevice: ssh.readField(output, 'KVM_DEV') === 'yes',
    cpuVirtFlags: parseInt(ssh.readField(output, 'CPU_VIRT') || '0', 10)
  };

  const rounded = roundUpSpecs(raw);

  return {
    ...raw,
    cpu: rounded.cpu,
    ram: rounded.ram,
    storage: Math.floor(raw.storage),
    storageAvail: Math.floor(raw.storageAvail)
  };
}

module.exports = {
  detectVPSSpecs,
  parseSpecs,
  DETECT_COMMAND
};
