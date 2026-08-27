const ssh = require('./ssh');

/**
 * Cek dukungan KVM.
 *
 * Perbaikan penting dari versi lama:
 *  - `kvm-ok` KELUAR DENGAN EXIT CODE 1 kalau KVM tidak tersedia. Itu jawaban
 *    yang sah, bukan error. Versi lama me-reject di situ, sehingga setiap VPS
 *    non-KVM dilaporkan sebagai "Gagal terhubung ke VPS" dan jalur non-KVM
 *    (rdpn.sh / armn.sh) tidak pernah terpakai.
 *  - Deteksi utama sekarang tidak butuh apt sama sekali: cukup /dev/kvm dan
 *    flag vmx/svm di /proc/cpuinfo. `kvm-ok` hanya dipakai sebagai konfirmasi
 *    tambahan kalau kebetulan sudah terpasang.
 *  - Menunggu lock apt lepas, karena VPS yang baru dibuat masih menjalankan
 *    cloud-init / unattended-upgrades dan apt akan gagal beberapa menit pertama.
 */
const KVM_CHECK_COMMAND = `
KVM_DEV=no
[ -e /dev/kvm ] && KVM_DEV=yes

CPU_FLAGS=$(grep -Ec '(vmx|svm)' /proc/cpuinfo 2>/dev/null | head -n1)
[ -z "$CPU_FLAGS" ] && CPU_FLAGS=0

MODULE=no
if lsmod 2>/dev/null | grep -qE '^(kvm_intel|kvm_amd|kvm)'; then MODULE=yes; fi

# Kalau /dev/kvm belum ada, coba muat modulnya dulu (sering belum ter-load di VPS fresh).
if [ "$KVM_DEV" = "no" ] && [ "$CPU_FLAGS" -gt 0 ]; then
  modprobe kvm >/dev/null 2>&1
  modprobe kvm_intel >/dev/null 2>&1 || modprobe kvm_amd >/dev/null 2>&1
  [ -e /dev/kvm ] && KVM_DEV=yes
fi

KVM_OK=unknown
if command -v kvm-ok >/dev/null 2>&1; then
  if kvm-ok 2>&1 | grep -q 'KVM acceleration can be used'; then
    KVM_OK=yes
  else
    KVM_OK=no
  fi
fi

WRITABLE=no
if [ -e /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then WRITABLE=yes; fi

echo "KVM_DEV=$KVM_DEV"
echo "CPU_FLAGS=$CPU_FLAGS"
echo "MODULE=$MODULE"
echo "KVM_OK=$KVM_OK"
echo "WRITABLE=$WRITABLE"
echo "CHECK_DONE=1"
`.trim();

async function checkVPSSupport(hostOrConn, username, password, port = 22) {
  const usingExistingConn =
    hostOrConn && typeof hostOrConn === 'object' && typeof hostOrConn.exec === 'function';

  let result;
  if (usingExistingConn) {
    result = await ssh.exec(hostOrConn, KVM_CHECK_COMMAND, { timeoutMs: 60000 });
  } else {
    result = await ssh.execOnce(
      { host: hostOrConn, port, username, password },
      KVM_CHECK_COMMAND,
      { timeoutMs: 60000 }
    );
  }

  return parseKvmResult(result.stdout);
}

function parseKvmResult(output) {
  if (!ssh.readField(output, 'CHECK_DONE')) {
    // Perintahnya sendiri tidak selesai — ini baru error sungguhan.
    throw new Error('KVM_CHECK_INCOMPLETE:Pemeriksaan KVM tidak selesai');
  }

  const hasDevice = ssh.readField(output, 'KVM_DEV') === 'yes';
  const writable = ssh.readField(output, 'WRITABLE') === 'yes';
  const cpuFlags = parseInt(ssh.readField(output, 'CPU_FLAGS') || '0', 10);
  const kvmOk = ssh.readField(output, 'KVM_OK');

  // kvm-ok, kalau ada, adalah sumber paling akurat. Kalau tidak ada, kita
  // simpulkan dari keberadaan /dev/kvm yang bisa dibaca-tulis.
  let supported;
  if (kvmOk === 'yes') supported = true;
  else if (kvmOk === 'no') supported = false;
  else supported = hasDevice && writable;

  return {
    supported,
    hasDevice,
    writable,
    cpuFlags,
    output
  };
}

module.exports = {
  checkVPSSupport,
  parseKvmResult,
  KVM_CHECK_COMMAND
};
