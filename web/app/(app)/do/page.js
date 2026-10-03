'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cloud, Plug, RefreshCw, Plus, Power, PowerOff, RotateCw, Zap, KeyRound, Camera, Trash2, Unplug, Server } from 'lucide-react';
import { api, rp, useMe } from '../../lib';
import { Alert, Badge, CopyButton, Empty, Loading, Modal, Stat, useUi } from '../../ui';

const ACTIONS = [
  ['on', 'Nyalakan', Power], ['off', 'Matikan', PowerOff], ['reboot', 'Reboot', RotateCw],
  ['cycle', 'Power cycle', Zap], ['kill', 'Matikan paksa', PowerOff], ['pwreset', 'Reset password', KeyRound],
  ['snap', 'Snapshot', Camera], ['delete', 'Hapus', Trash2]
];
const CONFIRM = {
  kill: 'Listrik droplet diputus seketika. Data yang belum tersimpan bisa hilang.',
  cycle: 'Droplet dimatikan lalu dinyalakan lagi. Proses yang berjalan bisa terputus.',
  pwreset: 'DigitalOcean me-restart droplet dan mengirim password root baru ke EMAIL akun DigitalOcean Anda.',
  snap: 'DigitalOcean menagih penyimpanan snapshot (~$0,06/GB/bulan). Droplet bisa mati sebentar.',
  delete: 'Droplet dihapus PERMANEN beserta semua datanya. Tidak bisa dikembalikan.'
};
const STATUS = { active: ['Menyala', 'ok'], off: ['Mati', 'bad'], new: ['Dibuat', 'warn'], archive: ['Arsip', ''] };

export default function DigitalOcean() {
  const router = useRouter();
  const { me } = useMe();
  const { toast, confirm } = useUi();
  // Token hanya di sessionStorage tab ini; server bot tidak menyimpannya.
  const [token, setToken] = useState('');
  const [input, setInput] = useState('');
  const [acc, setAcc] = useState(null);
  const [opts, setOpts] = useState(null);
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ region: 'sgp1', size: 's-2vcpu-4gb', image: 'ubuntu-22-04-x64', count: 1, rootPassword: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const call = (path, o = {}, t = token) => api(path, { ...o, headers: { 'x-do-token': t } });

  function disconnect() {
    try { sessionStorage.removeItem('doToken'); } catch (_) {}
    setToken(''); setAcc(null); setList(null);
  }

  async function connect(t) {
    setBusy('connect'); setErr('');
    try {
      const a = await call('/do/account', {}, t);
      setAcc(a); setToken(t);
      try { sessionStorage.setItem('doToken', t); } catch (_) {}
      setList(await call('/do/droplets', {}, t));
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

  async function act(d, key, label) {
    if (CONFIRM[key] && !(await confirm({ title: `${label} — ${d.name}?`, body: CONFIRM[key], ok: label, danger: key === 'delete' || key === 'kill' }))) return;
    setBusy(`${d.id}`);
    try {
      await call(`/do/droplets/${d.id}/${key}`, { method: 'POST' });
      toast(key === 'delete' ? `Droplet ${d.name} sedang dihapus.` : `Perintah "${label}" dikirim ke ${d.name}.`);
      setTimeout(refresh, 2500);
    } catch (e) { toast(e.message, 'bad'); }
    setBusy('');
  }

  async function create(e) {
    e.preventDefault();
    setBusy('create');
    try {
      const r = await call('/do/create', { method: 'POST', body: form });
      router.push(`/job/${r.jobId}`);
    } catch (e) { toast(e.message, 'bad'); setBusy(''); }
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
  const size = opts && opts.sizes.find((s) => s.slug === form.size);

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

    <div className="card mt">
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
                <td><b>{d.name}</b><div className="small muted">{d.image}</div></td>
                <td><Badge tone={tone}>{label}</Badge></td>
                <td className="mono">{d.ip ? <span className="row" style={{ gap: 6 }}>{d.ip}<CopyButton text={d.ip} /></span> : '-'}</td>
                <td>{d.vcpus} vCPU · {Math.round((d.memoryMb / 1024) * 10) / 10} GB · {d.diskGb} GB</td>
                <td>{d.region}</td>
                <td>{d.priceMonthly != null ? `$${d.priceMonthly}/bln` : '-'}</td>
                <td>
                  {busy === `${d.id}` ? <span className="spinner" /> : (
                    <select value="" aria-label="Aksi droplet" style={{ width: 150 }} disabled={d.locked}
                      onChange={(e) => { const a = ACTIONS.find((x) => x[0] === e.target.value); if (a) act(d, a[0], a[1]); }}>
                      <option value="">Pilih aksi…</option>
                      {ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  )}
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </div>

    {creating && opts && (
      <Modal title="Buat droplet baru" wide onClose={() => setCreating(false)}>
        <form onSubmit={create}>
          <div className="grid grid-2">
            <div><label style={{ marginTop: 0 }}>Region</label>
              <select value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
                {opts.regions.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
              </select></div>
            <div><label style={{ marginTop: 0 }}>Sistem operasi</label>
              <select value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })}>
                {opts.images.map((i) => <option key={i.slug} value={i.slug}>{i.name}</option>)}
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
              <input type="number" min={1} max={opts.maxDroplets} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} required /></div>
            <div><label>Password root (kosong = otomatis)</label>
              <input value={form.rootPassword} onChange={(e) => setForm({ ...form, rootPassword: e.target.value })} autoComplete="off" placeholder="@Mbahfauzi2025x" /></div>
          </div>
          <div className="hint">{opts.passwordRule}. Simbol yang boleh: <code>{opts.symbols}</code></div>
          <div className="mt"><Alert tone="info">
            Biaya bot <b>{rp(opts.cost)}</b> flat per batch (dipotong setelah droplet berhasil dibuat).
            Sewa droplet ±${size ? size.priceUsd * (Number(form.count) || 1) : 0}/bln ditagih DigitalOcean ke akun Anda.
            {size && size.ram < 4 && ' Untuk RDP Windows pilih minimal 2 vCPU · 4 GB.'}
          </Alert></div>
          {!me.admin && me.balance < opts.cost && <div className="mt"><Alert tone="warn">Saldo tidak cukup. <a href="/deposit">Deposit dulu</a>.</Alert></div>}
          <div className="row mt" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={() => setCreating(false)}>Batal</button>
            <button className="btn" disabled={busy === 'create'}>{busy === 'create' ? <span className="spinner" /> : <Plus size={16} />} Buat droplet</button>
          </div>
        </form>
      </Modal>
    )}
  </>);
}
