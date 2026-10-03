'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Cloud, Plug, RefreshCw, Plus, Power, Server, Unplug, TerminalSquare, Settings2, Camera, KeyRound, Trash2, HardDrive, History
} from 'lucide-react';
import { api, rp, tgl, useMe } from '../../lib';
import { Alert, Badge, CopyButton, Empty, Loading, Modal, Segmented, Stat, useUi } from '../../ui';

const QUICK = [
  ['on', 'Nyalakan'], ['off', 'Matikan'], ['reboot', 'Reboot'], ['cycle', 'Power cycle'],
  ['kill', 'Matikan paksa'], ['pwreset', 'Reset password root'], ['delete', 'Hapus droplet']
];
const CONFIRM = {
  kill: 'Listrik droplet diputus seketika. Data yang belum tersimpan bisa hilang.',
  cycle: 'Droplet dimatikan lalu dinyalakan lagi. Proses yang berjalan bisa terputus.',
  pwreset: 'DigitalOcean me-restart droplet dan mengirim password root baru ke EMAIL akun DigitalOcean Anda.',
  delete: 'Droplet dihapus PERMANEN beserta semua datanya. Tidak bisa dikembalikan.'
};
const STATUS = { active: ['Menyala', 'ok'], off: ['Mati', 'bad'], new: ['Dibuat', 'warn'], archive: ['Arsip', ''] };
const ACT_STATUS = { completed: ['Selesai', 'ok'], 'in-progress': ['Berjalan', 'warn'], errored: ['Gagal', 'bad'] };

const CLOUD_INIT = {
  '': '',
  update: '#cloud-config\npackage_update: true\npackage_upgrade: true\npackages:\n  - htop\n  - curl\n  - unzip\n',
  docker: '#!/bin/bash\ncurl -fsSL https://get.docker.com | sh\nsystemctl enable --now docker\n',
  swap: '#!/bin/bash\nfallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile\necho "/swapfile none swap sw 0 0" >> /etc/fstab\n',
  timezone: '#cloud-config\ntimezone: Asia/Jakarta\n'
};

/* ============ Detail & kelola satu droplet ============ */
function DropletDetail({ id, call, onClose, onChanged }) {
  const router = useRouter();
  const { toast, confirm } = useUi();
  const [d, setD] = useState(null);
  const [sizes, setSizes] = useState(null);
  const [opts, setOpts] = useState(null);
  const [tab, setTab] = useState('manage');
  const [f, setF] = useState({ name: '', size: '', disk: false, image: '', snap: '', restore: '' });
  const [busy, setBusy] = useState('');

  const load = () => call(`/do/droplets/${id}`).then((r) => { setD(r); setF((x) => ({ ...x, name: x.name || r.droplet.name })); })
    .catch((e) => { toast(e.message, 'bad'); onClose(); });
  useEffect(() => { load(); api('/do/options').then(setOpts).catch(() => {}); }, [id]);
  useEffect(() => { if (tab === 'manage' && !sizes) call('/do/sizes').then((r) => setSizes(r.sizes)).catch(() => setSizes([])); }, [tab]);

  async function action(body, label, warn) {
    if (warn && !(await confirm({ title: `${label}?`, body: warn, ok: label, danger: true }))) return;
    setBusy(body.type);
    try {
      await call(`/do/droplets/${id}/action`, { method: 'POST', body });
      toast(`"${label}" dikirim. Status diperbarui dalam beberapa detik.`);
      setTimeout(() => { load(); onChanged(); }, 2500);
    } catch (e) { toast(e.message, 'bad'); }
    setBusy('');
  }

  if (!d) return <Modal title="Memuat droplet…" wide onClose={onClose}><Loading /></Modal>;
  const dr = d.droplet;
  const has = (x) => dr.features.includes(x);
  const sizeList = (sizes || []).filter((s) => s.regions.includes(dr.regionSlug) && s.slug !== dr.sizeSlug)
    .sort((a, b) => a.priceMonthly - b.priceMonthly);
  const [label, tone] = STATUS[dr.status] || [dr.status, ''];

  return (
    <Modal title={dr.name} wide onClose={onClose}>
      <div className="row between">
        <div className="row"><Badge tone={tone}>{label}</Badge><span className="small muted">{dr.vcpus} vCPU · {Math.round(dr.memoryMb / 102.4) / 10} GB · {dr.diskGb} GB · {dr.region}</span></div>
        {dr.ip && <button className="btn sm" onClick={() => router.push(`/ssh?host=${dr.ip}&user=root`)}><TerminalSquare size={14} /> SSH Online</button>}
      </div>
      <dl className="kv mt">
        <dt>IPv4</dt><dd className="mono">{dr.ip || '-'}{dr.ip && <CopyButton text={dr.ip} />}</dd>
        <dt>IPv6</dt><dd className="mono">{dr.ipv6 || 'tidak aktif'}</dd>
        <dt>IP privat</dt><dd className="mono">{dr.privateIp || '-'}</dd>
        <dt>OS</dt><dd>{dr.image}</dd>
        <dt>Fitur</dt><dd>{has('backups') ? <Badge tone="ok">Backup</Badge> : null} {has('monitoring') ? <Badge tone="info">Monitoring</Badge> : null} {has('ipv6') ? <Badge>IPv6</Badge> : null}{!dr.features.length && '-'}</dd>
        {dr.nextBackup && (<><dt>Backup berikutnya</dt><dd>{tgl(dr.nextBackup)}</dd></>)}
      </dl>

      <div className="mt"><Segmented value={tab} onChange={setTab} options={[['manage', 'Kelola', Settings2], ['images', `Snapshot & backup (${d.images.length})`, Camera], ['log', 'Riwayat aksi', History]]} /></div>

      {tab === 'manage' && (
        <div className="grid grid-2 mt">
          <div className="card" style={{ boxShadow: 'none' }}>
            <h3>Ganti nama</h3>
            <div className="input-group mt-s">
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <button className="btn ghost" disabled={!!busy || !f.name || f.name === dr.name} onClick={() => action({ type: 'rename', name: f.name }, 'Ganti nama')}>Simpan</button>
            </div>
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <h3>Snapshot sekarang</h3>
            <div className="input-group mt-s">
              <input value={f.snap} onChange={(e) => setF({ ...f, snap: e.target.value })} placeholder="Nama snapshot (opsional)" />
              <button className="btn ghost" disabled={!!busy} onClick={() => action({ type: 'snapshot', name: f.snap || undefined }, 'Buat snapshot', 'DigitalOcean menagih penyimpanan snapshot (~$0,06/GB/bulan). Droplet bisa mati sebentar.')}><Camera size={14} /> Buat</button>
            </div>
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <h3>Resize (ubah ukuran)</h3>
            <p className="hint">Droplet harus <b>dimatikan</b> dulu. Resize disk bersifat permanen (tidak bisa diperkecil lagi).</p>
            <select value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} className="mt-s">
              <option value="">{sizes ? 'Pilih ukuran baru…' : 'Memuat ukuran…'}</option>
              {sizeList.map((s) => <option key={s.slug} value={s.slug}>{s.slug} — {s.vcpus} vCPU · {s.memoryMb / 1024} GB · {s.diskGb} GB · ${s.priceMonthly}/bln</option>)}
            </select>
            <label className="row" style={{ gap: 8, fontWeight: 500 }}><input type="checkbox" checked={f.disk} onChange={(e) => setF({ ...f, disk: e.target.checked })} style={{ width: 'auto' }} /> Ikut perbesar disk</label>
            <button className="btn ghost mt-s" disabled={!!busy || !f.size || dr.status !== 'off'} onClick={() => action({ type: 'resize', size: f.size, disk: f.disk }, 'Resize', `Ubah ke ${f.size}${f.disk ? ' termasuk disk (permanen)' : ''}. Tagihan DigitalOcean ikut berubah.`)}>
              <HardDrive size={14} /> Resize</button>
            {dr.status !== 'off' && <div className="hint">Matikan droplet dulu untuk resize.</div>}
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <h3>Rebuild (install ulang OS)</h3>
            <p className="hint">Semua data di droplet <b>dihapus</b>, IP tetap sama.</p>
            <select value={f.image} onChange={(e) => setF({ ...f, image: e.target.value })} className="mt-s">
              <option value="">Pilih OS / snapshot…</option>
              {(opts?.images || []).map((i) => <option key={i.slug} value={i.slug}>{i.name}</option>)}
              {d.images.map((i) => <option key={i.id} value={i.id}>{i.kind === 'backup' ? 'Backup' : 'Snapshot'}: {i.name}</option>)}
            </select>
            <button className="btn danger ghost mt-s" disabled={!!busy || !f.image} onClick={() => action({ type: 'rebuild', image: f.image }, 'Rebuild', 'Semua data di droplet ini akan DIHAPUS dan diganti OS baru.')}>Rebuild</button>
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <h3>Backup otomatis</h3>
            <p className="hint">Backup mingguan oleh DigitalOcean (+20% harga droplet).</p>
            {has('backups')
              ? <button className="btn danger ghost mt-s" disabled={!!busy} onClick={() => action({ type: 'disable_backups' }, 'Matikan backup', 'Backup otomatis dihentikan.')}>Matikan backup</button>
              : <button className="btn ghost mt-s" disabled={!!busy} onClick={() => action({ type: 'enable_backups' }, 'Aktifkan backup', 'DigitalOcean menambah biaya 20% dari harga droplet.')}>Aktifkan backup</button>}
          </div>
          <div className="card" style={{ boxShadow: 'none' }}>
            <h3>IPv6</h3>
            <p className="hint">Gratis. Setelah aktif tidak bisa dimatikan dari API.</p>
            <button className="btn ghost mt-s" disabled={!!busy || has('ipv6')} onClick={() => action({ type: 'enable_ipv6' }, 'Aktifkan IPv6')}>{has('ipv6') ? 'Sudah aktif' : 'Aktifkan IPv6'}</button>
          </div>
        </div>
      )}

      {tab === 'images' && (
        d.images.length === 0 ? <Empty icon={Camera} title="Belum ada snapshot atau backup">Buat snapshot dari tab Kelola.</Empty> : (
          <div className="table-wrap mt"><table>
            <thead><tr><th>Nama</th><th>Jenis</th><th>Ukuran</th><th>Dibuat</th><th /></tr></thead>
            <tbody>{d.images.map((i) => (
              <tr key={i.id}><td>{i.name}</td><td><Badge tone={i.kind === 'backup' ? 'info' : ''}>{i.kind}</Badge></td><td>{i.sizeGb} GB</td><td>{tgl(i.createdAt)}</td>
                <td><button className="btn danger ghost sm" disabled={!!busy} onClick={() => action({ type: 'restore', image: String(i.id) }, 'Restore', `Isi droplet akan dikembalikan ke "${i.name}". Data setelah titik itu HILANG.`)}>Restore</button></td></tr>
            ))}</tbody>
          </table></div>
        )
      )}

      {tab === 'log' && (
        d.actions.length === 0 ? <Empty icon={History} title="Belum ada aksi" /> : (
          <div className="table-wrap mt"><table>
            <thead><tr><th>Aksi</th><th>Status</th><th>Mulai</th><th>Selesai</th></tr></thead>
            <tbody>{d.actions.map((a) => (
              <tr key={a.id}><td>{a.type}</td><td><Badge tone={(ACT_STATUS[a.status] || [])[1]}>{(ACT_STATUS[a.status] || [a.status])[0]}</Badge></td><td>{tgl(a.startedAt)}</td><td>{tgl(a.completedAt)}</td></tr>
            ))}</tbody>
          </table></div>
        )
      )}
    </Modal>
  );
}

/* ============ Snapshot akun ============ */
function SnapshotsTab({ call }) {
  const { toast, confirm } = useUi();
  const [rows, setRows] = useState(null);
  const load = () => call('/do/snapshots').then((r) => setRows(r.snapshots)).catch((e) => { toast(e.message, 'bad'); setRows([]); });
  useEffect(() => { load(); }, []);
  async function del(s) {
    if (!(await confirm({ title: 'Hapus snapshot?', body: `"${s.name}" dihapus permanen.`, ok: 'Hapus', danger: true }))) return;
    try { await call(`/do/snapshots/${s.id}`, { method: 'DELETE' }); toast('Snapshot dihapus.'); load(); } catch (e) { toast(e.message, 'bad'); }
  }
  if (!rows) return <Loading />;
  const total = rows.reduce((n, s) => n + (Number(s.sizeGb) || 0), 0);
  return (
    <div className="card">
      <div className="card-head"><div><h2>Snapshot droplet</h2><p>Total {Math.round(total * 10) / 10} GB · ±${Math.round(total * 0.06 * 100) / 100}/bln</p></div>
        <button className="btn ghost sm" onClick={load}><RefreshCw size={14} /> Muat ulang</button></div>
      {rows.length === 0 ? <Empty icon={Camera} title="Belum ada snapshot" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Nama</th><th>Ukuran</th><th>Min. disk</th><th>Region</th><th>Dibuat</th><th /></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}><td>{s.name}</td><td>{s.sizeGb} GB</td><td>{s.minDiskGb} GB</td><td>{s.regions.join(', ')}</td><td>{tgl(s.createdAt)}</td>
              <td><button className="btn danger ghost sm" onClick={() => del(s)}><Trash2 size={13} /></button></td></tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="hint">Snapshot bisa dipakai untuk membuat droplet baru (pilih di "Buat droplet") atau rebuild/restore droplet.</p>
    </div>
  );
}

/* ============ SSH key akun ============ */
function KeysTab({ call }) {
  const { toast, confirm } = useUi();
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ name: '', public_key: '' });
  const load = () => call('/do/keys').then((r) => setRows(r.keys)).catch((e) => { toast(e.message, 'bad'); setRows([]); });
  useEffect(() => { load(); }, []);
  async function add(e) {
    e.preventDefault();
    try { await call('/do/keys', { method: 'POST', body: f }); toast('SSH key ditambahkan.'); setF({ name: '', public_key: '' }); load(); } catch (e) { toast(e.message, 'bad'); }
  }
  async function del(k) {
    if (!(await confirm({ title: 'Hapus SSH key?', body: `"${k.name}" dihapus dari akun DigitalOcean. Droplet yang sudah ada tidak terpengaruh.`, ok: 'Hapus', danger: true }))) return;
    try { await call(`/do/keys/${k.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'bad'); }
  }
  return (
    <div className="split">
      <div className="card">
        <h2>SSH key di akun</h2>
        {!rows ? <Loading /> : rows.length === 0 ? <Empty icon={KeyRound} title="Belum ada SSH key" /> : (
          <div className="list mt-s">{rows.map((k) => (
            <div className="list-item" key={k.id}>
              <div><div className="t">{k.name}</div><div className="d mono">{k.fingerprint}</div></div>
              <button className="btn danger ghost sm" onClick={() => del(k)}><Trash2 size={13} /></button>
            </div>
          ))}</div>
        )}
      </div>
      <form className="card" onSubmit={add}>
        <h3>Tambah SSH key</h3>
        <label>Nama</label>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="laptop-saya" required />
        <label>Public key</label>
        <textarea value={f.public_key} onChange={(e) => setF({ ...f, public_key: e.target.value })} placeholder="ssh-ed25519 AAAA… user@pc" required style={{ minHeight: 100 }} />
        <button className="btn mt"><Plus size={15} /> Tambah</button>
        <p className="hint">Isi dari file <code>~/.ssh/id_ed25519.pub</code>. Jangan pernah tempel private key di sini.</p>
      </form>
    </div>
  );
}

/* ============ Buat droplet ============ */
function CreateDroplet({ opts, call, onClose }) {
  const router = useRouter();
  const { me } = useMe();
  const { toast } = useUi();
  const [keys, setKeys] = useState([]);
  const [snaps, setSnaps] = useState([]);
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    region: 'sgp1', size: 's-2vcpu-4gb', image: 'ubuntu-22-04-x64', count: 1, rootPassword: '',
    userData: '', sshKeys: [], backups: false, monitoring: true, ipv6: true, tags: ''
  });
  useEffect(() => {
    call('/do/keys').then((r) => setKeys(r.keys)).catch(() => {});
    call('/do/snapshots').then((r) => setSnaps(r.snapshots)).catch(() => {});
  }, []);
  const size = opts.sizes.find((s) => s.slug === form.size);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await call('/do/create', { method: 'POST', body: form });
      router.push(`/job/${r.jobId}`);
    } catch (e) { toast(e.message, 'bad'); setBusy(false); }
  }

  return (
    <Modal title="Buat droplet baru" wide onClose={onClose}>
      <form onSubmit={create}>
        <div className="grid grid-2">
          <div><label style={{ marginTop: 0 }}>Region</label>
            <select value={form.region} onChange={set('region')}>{opts.regions.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}</select></div>
          <div><label style={{ marginTop: 0 }}>Sistem operasi / snapshot</label>
            <select value={form.image} onChange={set('image')}>
              <optgroup label="OS">{opts.images.map((i) => <option key={i.slug} value={i.slug}>{i.name}</option>)}</optgroup>
              {snaps.length > 0 && <optgroup label="Snapshot saya">{snaps.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
            </select></div>
        </div>
        <label>Ukuran</label>
        <div className="os-grid">
          {opts.sizes.map((s) => (
            <button type="button" key={s.slug} className={`os ${form.size === s.slug ? 'active' : ''}`} onClick={() => setForm({ ...form, size: s.slug })}>
              <span><span className="t">{s.name}</span><br /><span className="d">~${s.priceUsd}/bln{s.ram >= 4 ? ' · cocok RDP' : ''}</span></span>
            </button>
          ))}
        </div>
        <div className="grid grid-2">
          <div><label>Jumlah droplet (1–{opts.maxDroplets})</label>
            <input type="number" min={1} max={opts.maxDroplets} value={form.count} onChange={set('count')} required /></div>
          <div><label>Password root (kosong = otomatis)</label>
            <input value={form.rootPassword} onChange={set('rootPassword')} autoComplete="off" placeholder="@Mbahfauzi2025x" /></div>
        </div>
        <div className="hint">{opts.passwordRule}. Simbol yang boleh: <code>{opts.symbols}</code></div>

        {keys.length > 0 && (<>
          <label>SSH key (opsional)</label>
          <div className="chips">{keys.map((k) => {
            const on = form.sshKeys.includes(k.id);
            return <button type="button" key={k.id} className={`chip ${on ? 'active' : ''}`}
              onClick={() => setForm({ ...form, sshKeys: on ? form.sshKeys.filter((x) => x !== k.id) : [...form.sshKeys, k.id] })}><KeyRound size={12} /> {k.name}</button>;
          })}</div>
        </>)}

        <button type="button" className="btn ghost sm mt" onClick={() => setAdv(!adv)}><Settings2 size={14} /> {adv ? 'Sembunyikan' : 'Tampilkan'} opsi lanjutan (cloud-init, backup, tag)</button>
        {adv && (<>
          <div className="row mt">
            <label className="row" style={{ gap: 6, margin: 0, fontWeight: 500 }}><input type="checkbox" checked={form.monitoring} onChange={set('monitoring')} style={{ width: 'auto' }} /> Monitoring (gratis)</label>
            <label className="row" style={{ gap: 6, margin: 0, fontWeight: 500 }}><input type="checkbox" checked={form.ipv6} onChange={set('ipv6')} style={{ width: 'auto' }} /> IPv6 (gratis)</label>
            <label className="row" style={{ gap: 6, margin: 0, fontWeight: 500 }}><input type="checkbox" checked={form.backups} onChange={set('backups')} style={{ width: 'auto' }} /> Backup mingguan (+20%)</label>
          </div>
          <label>Tag (pisahkan koma)</label>
          <input value={form.tags} onChange={set('tags')} placeholder="produksi, rdp" />
          <div className="row between" style={{ marginTop: 14 }}>
            <label style={{ margin: 0 }}>Cloud-init / user data</label>
            <select style={{ width: 'auto' }} onChange={(e) => setForm({ ...form, userData: CLOUD_INIT[e.target.value] })} defaultValue="">
              <option value="">Template…</option>
              <option value="update">Update + paket dasar</option>
              <option value="docker">Install Docker</option>
              <option value="swap">Tambah swap 2 GB</option>
              <option value="timezone">Zona waktu WIB</option>
            </select>
          </div>
          <textarea value={form.userData} onChange={set('userData')} placeholder={'#cloud-config  atau  #!/bin/bash\n...'} style={{ marginTop: 6 }} />
          <div className="hint">Dijalankan sekali saat droplet pertama kali menyala. Format <code>#cloud-config</code> atau script <code>#!/bin/bash</code>, maks 60 KB. Pengaturan password root tetap dipasang otomatis.</div>
        </>)}

        <div className="mt"><Alert tone="info">
          Biaya bot <b>{rp(opts.cost)}</b> flat per batch (dipotong setelah droplet berhasil dibuat).
          Sewa droplet ±${size ? size.priceUsd * (Number(form.count) || 1) : 0}/bln{form.backups ? ' + 20% backup' : ''} ditagih DigitalOcean ke akun Anda.
          {size && size.ram < 4 && ' Untuk RDP Windows pilih minimal 2 vCPU · 4 GB.'}
        </Alert></div>
        {!me.admin && me.balance < opts.cost && <div className="mt"><Alert tone="warn">Saldo tidak cukup. <a href="/deposit">Deposit dulu</a>.</Alert></div>}
        <div className="row mt" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn" disabled={busy}>{busy ? <span className="spinner" /> : <Plus size={16} />} Buat droplet</button>
        </div>
      </form>
    </Modal>
  );
}

/* ============ Halaman ============ */
export default function DigitalOcean() {
  const router = useRouter();
  const { toast, confirm } = useUi();
  // Token hanya di sessionStorage tab ini; server bot tidak menyimpannya.
  const [token, setToken] = useState('');
  const [input, setInput] = useState('');
  const [acc, setAcc] = useState(null);
  const [opts, setOpts] = useState(null);
  const [list, setList] = useState(null);
  const [tab, setTab] = useState('droplets');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const callWith = (t) => (path, o = {}) => api(path, { ...o, headers: { 'x-do-token': t } });
  const call = callWith(token);

  function disconnect() {
    try { sessionStorage.removeItem('doToken'); } catch (_) {}
    setToken(''); setAcc(null); setList(null);
  }

  async function connect(t) {
    setBusy('connect'); setErr('');
    try {
      const a = await callWith(t)('/do/account');
      setAcc(a); setToken(t);
      try { sessionStorage.setItem('doToken', t); } catch (_) {}
      setList(await callWith(t)('/do/droplets'));
    } catch (e) {
      setErr(e.message);
      if (e.status === 401) disconnect();
    }
    setBusy('');
  }

  useEffect(() => {
    api('/do/options').then(setOpts).catch(() => {});
    let saved = '';
    try { saved = sessionStorage.getItem('doToken') || ''; } catch (_) {}
    if (saved) connect(saved);
  }, []);

  async function refresh() {
    setBusy('list');
    try { setList(await call('/do/droplets')); } catch (e) { toast(e.message, 'bad'); if (e.status === 401) disconnect(); }
    setBusy('');
  }

  async function quick(d, key) {
    if (key === 'ssh') return router.push(`/ssh?host=${d.ip}&user=root`);
    if (key === 'manage') return setDetail(d.id);
    const label = (QUICK.find((q) => q[0] === key) || [])[1];
    if (CONFIRM[key] && !(await confirm({ title: `${label} — ${d.name}?`, body: CONFIRM[key], ok: label, danger: key === 'delete' || key === 'kill' }))) return;
    setBusy(`${d.id}`);
    try {
      await call(`/do/droplets/${d.id}/${key}`, { method: 'POST' });
      toast(key === 'delete' ? `Droplet ${d.name} sedang dihapus.` : `Perintah "${label}" dikirim ke ${d.name}.`);
      setTimeout(refresh, 2500);
    } catch (e) { toast(e.message, 'bad'); }
    setBusy('');
  }

  if (!acc) {
    return (<>
      <div className="page-head"><div><h1>Control DigitalOcean</h1><p>Kelola droplet di akun DigitalOcean Anda sendiri.</p></div></div>
      <div className="split">
        <form className="card" onSubmit={(e) => { e.preventDefault(); connect(input.trim()); }}>
          <h2><Plug size={16} style={{ verticalAlign: -2 }} /> Hubungkan akun</h2>
          <label htmlFor="tok">Personal Access Token (scope Read + Write)</label>
          <input id="tok" type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="dop_v1_…" autoComplete="off" required />
          {err && <div className="mt"><Alert tone="bad">{err}</Alert></div>}
          <button className="btn mt" disabled={!!busy}>{busy ? <span className="spinner" /> : <Plug size={16} />} Hubungkan</button>
        </form>
        <div className="card">
          <h3>Cara membuat token</h3>
          <ol className="small" style={{ paddingLeft: 18 }}>
            <li>Buka <a href="https://cloud.digitalocean.com/account/api/tokens" target="_blank" rel="noreferrer">cloud.digitalocean.com → API</a></li>
            <li>Klik <b>Generate New Token</b>, pilih scope <b>Full Access</b> (Read + Write).</li>
            <li>Salin token lalu tempel di sini.</li>
          </ol>
          <Alert tone="info">Token hanya disimpan di tab browser ini, tidak di server. Semua fitur gratis kecuali buat droplet ({opts ? rp(opts.cost) : '…'} flat per batch).</Alert>
        </div>
      </div>
    </>);
  }

  const droplets = list ? list.droplets : [];

  return (<>
    <div className="page-head">
      <div><h1>Control DigitalOcean</h1><p>{acc.email || 'Akun terhubung'}{acc.status ? ` · status ${acc.status}` : ''}</p></div>
      <div className="row">
        <button className="btn" onClick={() => setCreating(true)} disabled={!opts}><Plus size={16} /> Buat droplet</button>
        <button className="btn ghost" onClick={disconnect}><Unplug size={16} /> Putuskan</button>
      </div>
    </div>

    <div className="grid grid-3">
      <Stat icon={Server} label="Total droplet" value={list ? list.total : '…'} hint={acc.dropletLimit ? `Batas akun: ${acc.dropletLimit}` : null} />
      <Stat icon={Power} tone="ok" label="Menyala" value={droplets.filter((d) => d.status === 'active').length} />
      <Stat icon={Cloud} tone="info" label="Tagihan bulan ini" value={acc.billing && acc.billing.monthToDateUsage != null ? `$${acc.billing.monthToDateUsage}` : '-'} hint={acc.billing ? null : 'Token tidak punya izin billing'} />
    </div>

    <div className="mt" style={{ marginBottom: 16 }}>
      <Segmented value={tab} onChange={setTab} options={[['droplets', 'Droplet', Server], ['snapshots', 'Snapshot', Camera], ['keys', 'SSH Key', KeyRound]]} />
    </div>

    {tab === 'droplets' && (
      <div className="card">
        <div className="card-head">
          <h2>Droplet</h2>
          <button className="btn ghost sm" onClick={refresh} disabled={!!busy}><RefreshCw size={14} /> Muat ulang</button>
        </div>
        {!list ? <Loading /> : droplets.length === 0 ? (
          <Empty icon={Cloud} title="Belum ada droplet">Buat droplet pertama Anda dengan tombol "Buat droplet".</Empty>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Nama</th><th>Status</th><th>IP</th><th>Spesifikasi</th><th>Region</th><th>Biaya</th><th>Aksi</th></tr></thead>
            <tbody>{droplets.map((d) => {
              const [label, tone] = STATUS[d.status] || [d.status, ''];
              return (
                <tr key={d.id}>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); setDetail(d.id); }}><b>{d.name}</b></a><div className="small muted">{d.image}</div></td>
                  <td><Badge tone={tone}>{label}</Badge></td>
                  <td className="mono">{d.ip ? <span className="row" style={{ gap: 6 }}>{d.ip}<CopyButton text={d.ip} /></span> : '-'}</td>
                  <td>{d.vcpus} vCPU · {Math.round((d.memoryMb / 1024) * 10) / 10} GB · {d.diskGb} GB</td>
                  <td>{d.region}</td>
                  <td>{d.priceMonthly != null ? `$${d.priceMonthly}/bln` : '-'}</td>
                  <td>
                    {busy === `${d.id}` ? <span className="spinner" /> : (
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        {d.ip && <button className="icon-btn" title="SSH Online" aria-label="SSH Online" onClick={() => quick(d, 'ssh')}><TerminalSquare size={15} /></button>}
                        <button className="icon-btn" title="Kelola" aria-label="Kelola" onClick={() => quick(d, 'manage')}><Settings2 size={15} /></button>
                        <select value="" aria-label="Aksi droplet" style={{ width: 140 }} disabled={d.locked} onChange={(e) => e.target.value && quick(d, e.target.value)}>
                          <option value="">Aksi cepat…</option>
                          {QUICK.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    )}
    {tab === 'snapshots' && <SnapshotsTab call={call} />}
    {tab === 'keys' && <KeysTab call={call} />}

    {creating && opts && <CreateDroplet opts={opts} call={call} onClose={() => setCreating(false)} />}
    {detail && <DropletDetail id={detail} call={call} onClose={() => setDetail(null)} onChanged={refresh} />}
  </>);
}
