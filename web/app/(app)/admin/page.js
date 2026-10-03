'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard, Users, Wallet, Activity, MonitorDown, Receipt, UserCog, Megaphone, Download,
  TrendingUp, CircleDollarSign, UserPlus, CheckCircle2, Clock, Lock, Search, RefreshCw, Trash2, KeyRound, ScrollText, ShieldAlert, SlidersHorizontal, Ban, Wrench, Megaphone as AdIcon
} from 'lucide-react';
import { api, rp, tgl, useMe, usePoll, userLabel, trxLabel, trxTone, INSTALL_STATUS, JOB_STATUS } from '../../lib';
import { Alert, Badge, BarChart, Empty, Loading, Modal, Progress, Stat, StatusBadge, useUi } from '../../ui';

const TABS = [
  ['overview', 'Ringkasan', LayoutDashboard], ['users', 'User', Users], ['deposits', 'Deposit', Wallet],
  ['jobs', 'Proses', Activity], ['inst', 'Instalasi', MonitorDown], ['trx', 'Transaksi', Receipt],
  ['accounts', 'Akun Web', UserCog], ['broadcast', 'Broadcast', Megaphone], ['settings', 'Pengaturan', SlidersHorizontal], ['log', 'Log Aktivitas', ScrollText]
];
const shortDay = (d) => { const [, m, day] = d.day.split('-'); return `${Number(day)}/${Number(m)}`; };
const rpShort = (v, compact) => (compact && v >= 1000 ? `Rp ${Math.round(v / 1000).toLocaleString('id-ID')}rb` : rp(v));

/* ================= Unduh backup (wajib OTP) ================= */
function ExportButton() {
  const { toast } = useUi();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  async function request() {
    setBusy(true);
    try { await api('/admin/export/otp', { method: 'POST' }); setOpen(true); setCode(''); }
    catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }
  async function download(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/export?code=${encodeURIComponent(code)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Gagal mengunduh.');
      const blob = await res.blob();
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob), download: `backup-saldo-${new Date().toISOString().slice(0, 10)}.json`
      });
      a.click();
      URL.revokeObjectURL(a.href);
      setOpen(false);
      toast('Backup diunduh. Simpan file ini di tempat yang aman.');
    } catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }
  return (<>
    <button className="btn ghost" onClick={request} disabled={busy}><Download size={16} /> Unduh backup</button>
    {open && (
      <Modal title="Verifikasi unduh backup" onClose={() => setOpen(false)}>
        <form onSubmit={download}>
          <p className="small" style={{ marginTop: 0 }}>Kode OTP dikirim ke Telegram admin. Unduhan ini dicatat di log aktivitas. File tidak berisi password, tapi tetap berisi data saldo semua user — jangan dibagikan.</p>
          <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="Kode 6 digit" autoFocus required />
          <button className="btn block mt" disabled={busy || code.length !== 6}>{busy ? <span className="spinner" /> : <Download size={16} />} Unduh</button>
        </form>
      </Modal>
    )}
  </>);
}

/* ================= Ringkasan ================= */
function Overview() {
  const [o, setO] = useState(null);
  const [err, setErr] = useState('');
  usePoll(() => api('/admin/overview').then(setO).catch((e) => setErr(e.message)), 30000);
  if (err && !o) return <Alert tone="bad">{err}</Alert>;
  if (!o) return <Loading />;
  const t = o.today;
  return (<>
    {!o.backupOk && <div style={{ marginBottom: 16 }}><Alert tone="bad"><b>Cadangan otomatis DIKUNCI:</b> {o.backupLockReason}. Jangan biarkan user bertransaksi; perbaiki koneksi lalu restart bot.</Alert></div>}
    <div className="grid grid-4">
      <Stat icon={CircleDollarSign} tone="ok" label="Deposit hari ini" value={rp(t.deposit)} />
      <Stat icon={TrendingUp} label="Pendapatan hari ini" value={rp(t.revenue)} hint="Pemakaian − refund" />
      <Stat icon={CheckCircle2} tone="info" label="Install hari ini" value={`${t.success} berhasil`} hint={`${t.failed} gagal`} />
      <Stat icon={UserPlus} tone="warn" label="User baru hari ini" value={o.newUsersToday} />
    </div>
    <div className="grid grid-4 mt">
      <Stat icon={Users} label="Total user bot" value={o.users.toLocaleString('id-ID')} hint={`${o.webAccounts} punya akun web`} />
      <Stat icon={Wallet} label="Total saldo user" value={rp(o.totalSaldo)} hint="Kewajiban ke user" />
      <Stat icon={Clock} tone="warn" label="Deposit menunggu" value={o.pendingDeposits} />
      <Stat icon={Lock} tone="info" label="Saldo ditahan" value={rp(o.held)} hint={`${o.runningJobs} proses web berjalan`} />
    </div>
    <div className="grid grid-2 mt">
      <div className="card">
        <div className="card-head"><div><h2>Deposit masuk</h2><p>14 hari terakhir</p></div><b>{rp(o.series.reduce((n, d) => n + d.deposit, 0))}</b></div>
        <BarChart title="Deposit per hari" data={o.series} value={(d) => d.deposit} label={(d, s) => (s ? shortDay(d) : d.day)} format={rpShort} />
      </div>
      <div className="card">
        <div className="card-head"><div><h2>Instalasi berhasil</h2><p>14 hari terakhir</p></div><b>{o.series.reduce((n, d) => n + d.success, 0)} VPS</b></div>
        <BarChart title="Instalasi berhasil per hari" data={o.series} value={(d) => d.success} label={(d, s) => (s ? shortDay(d) : d.day)} format={(v) => `${v} VPS`} />
      </div>
    </div>
    <div className="card mt">
      <div className="row between">
        <div><h2>Cadangan data</h2><p className="small muted" style={{ margin: '4px 0 0' }}>Data diperbarui {tgl(o.updated_at)}. Cadangan otomatis tetap dikirim ke Telegram. Unduhan manual wajib OTP dan tercatat di log.</p></div>
        <ExportButton />
      </div>
    </div>
  </>);
}

/* ================= Detail user ================= */
function UserDetail({ id, onClose, onChanged }) {
  const { toast, confirm } = useUi();
  const [d, setD] = useState(null);
  const [amount, setAmount] = useState('');
  const [pw, setPw] = useState('');
  const load = useCallback(() => api(`/admin/users/${id}`).then(setD).catch((e) => { toast(e.message, 'bad'); onClose(); }), [id]);
  useEffect(() => { load(); }, [load]);

  async function adjust(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v === 0) return toast('Jumlah tidak valid.', 'bad');
    if (!(await confirm({ title: v > 0 ? 'Tambah saldo?' : 'Kurangi saldo?', body: `${v > 0 ? 'Tambah' : 'Kurangi'} ${rp(Math.abs(v))} untuk user ${userLabel(id)}. Perubahan ini dicatat di log aktivitas.`, danger: v < 0 }))) return;
    try {
      const r = await api('/admin/balance', { method: 'POST', body: { user_id: id, amount: v } });
      toast(`Saldo sekarang ${rp(r.balance)}.`);
      setAmount(''); load(); onChanged();
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function toggleBlock() {
    if (d.blocked) {
      if (!(await confirm({ title: 'Buka blokir?', body: `User ${userLabel(id)} bisa login dan bertransaksi lagi.` }))) return;
      try { await api(`/admin/users/${id}/block`, { method: 'DELETE' }); toast('Blokir dibuka.'); load(); onChanged(); } catch (e) { toast(e.message, 'bad'); }
      return;
    }
    const reason = prompt('Alasan blokir (opsional, akan dilihat user):', '');
    if (reason === null) return;
    try { await api(`/admin/users/${id}/block`, { method: 'POST', body: { reason } }); toast('User diblokir. Saldonya tetap aman.'); load(); onChanged(); } catch (e) { toast(e.message, 'bad'); }
  }

  async function resetPw(e) {
    e.preventDefault();
    try { await api(`/admin/accounts/${d.account.username}/password`, { method: 'POST', body: { password: pw } }); toast('Password akun web diganti.'); setPw(''); }
    catch (e) { toast(e.message, 'bad'); }
  }

  return (
    <Modal title={`User ${userLabel(id)}`} wide onClose={onClose}>
      {!d ? <Loading /> : (<>
        <div className="grid grid-3">
          <Stat icon={Wallet} label="Saldo" value={rp(d.user.balance)} hint={d.user.admin ? 'Admin (unlimited)' : null} />
          <Stat icon={UserCog} label="Akun web" value={d.account ? d.account.username : '-'} hint={d.account ? `sejak ${tgl(d.account.created_at)}` : 'Belum daftar web'} />
          <Stat icon={Activity} tone={d.blocked ? 'bad' : d.installing ? 'warn' : ''} label="Status" value={d.blocked ? 'Diblokir' : d.installing ? 'Menginstal' : 'Aktif'} hint={`terdaftar ${tgl(d.user.created_at)}`} />
        </div>
        {d.blocked && <div className="mt"><Alert tone="bad">Diblokir oleh <b>{d.blocked.by}</b> pada {tgl(d.blocked.at)}{d.blocked.reason ? ` — ${d.blocked.reason}` : ''}.</Alert></div>}
        {!d.user.admin && (
          <div className="mt"><button className={`btn sm ${d.blocked ? 'ghost' : 'danger ghost'}`} onClick={toggleBlock}><Ban size={14} /> {d.blocked ? 'Buka blokir' : 'Blokir user'}</button></div>
        )}
        <div className="grid grid-2 mt">
          <div>
            <h3>Ubah saldo</h3>
            <div className="chips mt-s">
              {[5000, 10000, 50000, 100000].map((n) => <button key={n} type="button" className="chip" onClick={() => adjust(n)}>+{rp(n)}</button>)}
            </div>
            <form className="input-group mt-s" onSubmit={(e) => { e.preventDefault(); adjust(amount); }}>
              <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, ''))} placeholder="Jumlah (minus untuk mengurangi)" />
              <button className="btn">Simpan</button>
            </form>
          </div>
          {d.account && (
            <form onSubmit={resetPw}>
              <h3>Reset password web</h3>
              <div className="input-group mt-s">
                <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password baru (min 8)" minLength={8} required />
                <button className="btn ghost"><KeyRound size={15} /> Ganti</button>
              </div>
              <div className="hint">{d.account.web_only ? 'Akun website: reset password hanya bisa lewat admin.' : 'Untuk user yang kehilangan akses Telegram.'}</div>
            </form>
          )}
        </div>
        <h3 className="mt">Transaksi</h3>
        {d.transactions.length === 0 ? <p className="muted small">Belum ada.</p> : (
          <div className="table-wrap" style={{ maxHeight: 240 }}><table>
            <tbody>{d.transactions.map((t) => (
              <tr key={t.id}><td>{tgl(t.created_at)}</td><td><Badge tone={trxTone(t.type)}>{trxLabel(t.type)}</Badge></td>
                <td className={`right ${t.amount >= 0 ? 'pos' : ''}`}>{t.amount >= 0 ? '+' : '−'}{rp(Math.abs(t.amount))}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        <h3 className="mt">Instalasi</h3>
        {d.installations.length === 0 ? <p className="muted small">Belum ada.</p> : (
          <div className="table-wrap" style={{ maxHeight: 240 }}><table>
            <tbody>{d.installations.map((r) => (
              <tr key={r.id}><td>{tgl(r.created_at)}</td><td className="mono">{r.ip}</td><td>{r.windows_name}</td><td><StatusBadge map={INSTALL_STATUS} value={r.status} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </>)}
    </Modal>
  );
}

/* ================= User ================= */
/** Form cepat tambah/kurangi saldo: ID Telegram, Web #n, atau username web. */
function QuickBalance({ onDone }) {
  const { toast, confirm } = useUi();
  const [f, setF] = useState({ user_id: '', amount: '' });
  const [busy, setBusy] = useState(false);
  const n = parseInt(String(f.amount).replace(/[^\d-]/g, ''), 10);
  async function submit(e) {
    e.preventDefault();
    if (!Number.isInteger(n) || n === 0) return toast('Jumlah tidak valid.', 'bad');
    if (!(await confirm({ title: n > 0 ? 'Tambah saldo?' : 'Kurangi saldo?', body: `${n > 0 ? 'Tambah' : 'Kurangi'} ${rp(Math.abs(n))} untuk "${f.user_id}". Tercatat di log aktivitas.`, danger: n < 0 }))) return;
    setBusy(true);
    try {
      const r = await api('/admin/balance', { method: 'POST', body: { user_id: f.user_id, amount: n } });
      toast(`Saldo ${userLabel(r.user_id)} sekarang ${rp(r.balance)}.`);
      setF({ user_id: f.user_id, amount: '' });
      onDone();
    } catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2><Wallet size={16} style={{ verticalAlign: -2 }} /> Tambah / kurangi saldo</h2>
      <div className="grid grid-2 mt-s">
        <div><label style={{ marginTop: 0 }}>User</label>
          <input value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} placeholder="ID Telegram, Web #3, atau username" required /></div>
        <div><label style={{ marginTop: 0 }}>Jumlah (minus untuk mengurangi)</label>
          <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d-]/g, '') })} placeholder="50000 atau -5000" inputMode="numeric" required /></div>
      </div>
      <div className="row mt-s">
        {[10000, 20000, 50000, 100000].map((v) => <button type="button" key={v} className="chip" onClick={() => setF({ ...f, amount: String(v) })}>{rp(v)}</button>)}
        <button className="btn" disabled={busy} style={{ marginLeft: 'auto' }}>{busy ? <span className="spinner" /> : <Wallet size={15} />} Simpan</button>
      </div>
    </form>
  );
}

function UsersTab() {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const load = (query = q) => api(`/admin/users?q=${encodeURIComponent(query)}`).then(setData).catch(() => setData({ users: [], total: 0 }));
  useEffect(() => { load(''); }, []);
  return (<>
    <QuickBalance onDone={() => load()} />
    <div className="card">
      <form className="input-group" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <div className="input-icon" style={{ flex: 1 }}><Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari ID Telegram, Web #, atau username" /></div>
        <button className="btn">Cari</button>
      </form>
      {!data ? <Loading /> : data.users.length === 0 ? <Empty icon={Users} title="User tidak ditemukan" /> : (<>
        <p className="small muted">{data.total.toLocaleString('id-ID')} user · diurutkan dari saldo terbesar · klik baris untuk detail</p>
        <div className="table-wrap"><table>
          <thead><tr><th>ID user</th><th>Username web</th><th className="right">Saldo</th><th>Terdaftar</th></tr></thead>
          <tbody>{data.users.map((u) => (
            <tr key={u.telegram_id} className="clickable" onClick={() => setOpen(u.telegram_id)}>
              <td className="mono">{userLabel(u.telegram_id)} {u.blocked && <Badge tone="bad">diblokir</Badge>}</td><td>{u.username || <span className="muted">-</span>}</td>
              <td className="right"><b>{rp(u.balance)}</b></td><td>{tgl(u.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {data.total > data.users.length && <p className="hint">Menampilkan {data.users.length} teratas. Gunakan pencarian.</p>}
      </>)}
      {open && <UserDetail id={open} onClose={() => setOpen(null)} onChanged={() => load()} />}
    </div>
  </>);
}

/* ================= Deposit ================= */
function DepositsTab() {
  const { toast, confirm } = useUi();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api('/admin/deposits').then(setD).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, []);
  const STATE = { credited: 'Lunas — saldo sudah ditambahkan.', already: 'Sudah lunas sebelumnya.', unpaid: 'Belum dibayar.', expired: 'Kadaluarsa di Pakasir, dihapus dari antrean.', error: 'Gagal menghubungi Pakasir.', unknown: 'Tidak ditemukan.' };
  async function check(ref) {
    setBusy(ref);
    try { const r = await api(`/admin/deposits/${ref}/check`, { method: 'POST' }); toast(STATE[r.state] || r.state, r.state === 'error' ? 'bad' : 'ok'); load(); }
    catch (e) { toast(e.message, 'bad'); }
    setBusy('');
  }
  async function del(ref) {
    if (!(await confirm({ title: 'Hapus dari antrean?', body: `Deposit ${ref} tidak akan dipantau lagi. Kalau ternyata sudah dibayar, saldo harus ditambahkan manual.`, danger: true, ok: 'Hapus' }))) return;
    try { await api(`/admin/deposits/${ref}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, 'bad'); }
  }
  if (!d) return <Loading />;
  return (<>
    <div className="card">
      <div className="card-head"><div><h2>Menunggu pembayaran ({d.pending.length})</h2><p>Cek status langsung ke Pakasir bila user lapor sudah bayar.</p></div>
        <button className="btn ghost sm" onClick={load}><RefreshCw size={14} /> Muat ulang</button></div>
      {d.pending.length === 0 ? <Empty icon={Wallet} title="Tidak ada deposit yang menunggu" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Waktu</th><th>Ref</th><th>User</th><th className="right">Nominal</th><th>Kadaluarsa</th><th /></tr></thead>
          <tbody>{d.pending.map((p) => (
            <tr key={p.ref}><td>{tgl(p.at)}</td><td className="mono">{p.ref}</td><td className="mono">{p.user_id}</td>
              <td className="right">{rp(p.credit || p.amount)}</td><td>{tgl(p.expired_at)}</td>
              <td className="row" style={{ flexWrap: 'nowrap' }}>
                <button className="btn soft sm" onClick={() => check(p.ref)} disabled={busy === p.ref}>{busy === p.ref ? <span className="spinner" /> : <RefreshCw size={13} />} Cek</button>
                <button className="btn danger ghost sm" onClick={() => del(p.ref)} aria-label="Hapus"><Trash2 size={13} /></button>
              </td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
    <div className="card">
      <h2>Deposit lunas terakhir</h2>
      {d.credited.length === 0 ? <Empty title="Belum ada" /> : (
        <div className="table-wrap mt-s"><table>
          <thead><tr><th>Waktu</th><th>Ref</th><th>User</th><th className="right">Saldo masuk</th></tr></thead>
          <tbody>{d.credited.map((c) => (
            <tr key={c.ref}><td>{tgl(c.at)}</td><td className="mono">{c.ref}</td><td className="mono">{c.user_id}</td><td className="right pos"><b>+{rp(c.amount)}</b></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  </>);
}

/* ================= Proses berjalan ================= */
function JobsTab() {
  const [d, setD] = useState(null);
  usePoll(() => api('/admin/jobs').then(setD).catch(() => setD({ jobs: [], running: [] })), 8000);
  if (!d) return <Loading />;
  return (<>
    <div className="card">
      <div className="card-head"><div><h2>Proses dari website</h2><p>Diperbarui otomatis. Hilang dari daftar ini setelah bot restart.</p></div></div>
      {d.jobs.length === 0 ? <Empty icon={Activity} title="Belum ada proses" /> : (
        <div className="list">{d.jobs.map((j) => (
          <div key={j.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t">{j.kind === 'install' ? `Install ${j.title}` : `Droplet: ${j.title}`} · {j.username || j.user_id}</div>
              <div className="d">{tgl(j.created_at)}</div>
              {j.kind === 'install' && <div className="grid mt-s" style={{ gap: 6 }}>{j.items.map((s) => (
                <div key={s.ip} className="row small" style={{ gap: 8 }}>
                  <span className="mono" style={{ minWidth: 120 }}>{s.ip}</span>
                  <StatusBadge map={JOB_STATUS} value={s.status} />
                  {s.status === 'installing' && <span style={{ flex: 1, minWidth: 80 }}><Progress value={s.percent} /></span>}
                  {s.refunded && <Badge tone="ok">refund</Badge>}
                  {(s.status === 'failed' || s.status === 'skipped') && <span className="muted">{s.note}</span>}
                </div>
              ))}</div>}
            </div>
            <Badge tone={j.status === 'running' ? 'warn' : 'ok'}>{j.status === 'running' ? 'Berjalan' : 'Selesai'}</Badge>
          </div>
        ))}</div>
      )}
    </div>
    <div className="card">
      <h2>Instalasi tercatat "berjalan"</h2>
      <p className="small muted">Termasuk dari bot Telegram. Entri lama yang macet di status ini biasanya terputus karena restart.</p>
      {d.running.length === 0 ? <Empty title="Tidak ada" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Mulai</th><th>User</th><th>IP</th><th>Windows</th></tr></thead>
          <tbody>{d.running.map((r) => <tr key={r.id}><td>{tgl(r.created_at)}</td><td className="mono">{r.user_id}</td><td className="mono">{r.ip}</td><td>{r.windows_name}</td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  </>);
}

/* ================= Instalasi ================= */
function InstallsTab() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  useEffect(() => { api('/admin/installations').then((d) => setRows(d.installations)).catch(() => setRows([])); }, []);
  if (!rows) return <Loading />;
  const list = status ? rows.filter((r) => String(r.status).startsWith(status)) : rows;
  const ok = rows.filter((r) => String(r.status).startsWith('success')).length;
  const fail = rows.filter((r) => r.status === 'failed').length;
  return (
    <div className="card">
      <div className="card-head">
        <div className="row small"><Badge tone="ok">{ok} berhasil</Badge><Badge tone="bad">{fail} gagal</Badge>
          <span className="muted">tingkat sukses {ok + fail ? Math.round((ok / (ok + fail)) * 100) : 0}% (200 terakhir)</span></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Filter status">
          <option value="">Semua status</option><option value="success">Berhasil</option><option value="failed">Gagal</option><option value="running">Berjalan</option>
        </select>
      </div>
      {list.length === 0 ? <Empty icon={MonitorDown} title="Tidak ada data" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Waktu</th><th>User</th><th>IP</th><th>Windows</th><th>Status</th><th>Keterangan</th></tr></thead>
          <tbody>{list.map((r) => (
            <tr key={r.id}><td>{tgl(r.created_at)}</td><td className="mono">{r.user_id}</td><td className="mono">{r.ip}</td><td>{r.windows_name}</td>
              <td><StatusBadge map={INSTALL_STATUS} value={r.status} /></td><td className="wrap small muted">{r.note ? String(r.note).slice(0, 140) : ''}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

/* ================= Transaksi ================= */
function TrxTab() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [rows, setRows] = useState(null);
  const load = (query = q) => api(`/admin/transactions${query ? `?user_id=${encodeURIComponent(query)}` : ''}`).then((d) => setRows(d.transactions)).catch(() => setRows([]));
  useEffect(() => { load(''); }, []);
  const list = (rows || []).filter((t) => !type || t.type === type);
  const types = [...new Set((rows || []).map((t) => t.type))];
  return (
    <div className="card">
      <form className="input-group" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value.replace(/[^\d-]/g, ''))} placeholder="Filter ID user, akun web pakai minus mis. -3 (kosong = semua)" />
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }} aria-label="Jenis">
          <option value="">Semua jenis</option>{types.map((t) => <option key={t} value={t}>{trxLabel(t)}</option>)}
        </select>
        <button className="btn">Filter</button>
      </form>
      {!rows ? <Loading /> : list.length === 0 ? <Empty icon={Receipt} title="Tidak ada transaksi" /> : (
        <div className="table-wrap mt"><table>
          <thead><tr><th>Waktu</th><th>User</th><th>Jenis</th><th className="right">Jumlah</th></tr></thead>
          <tbody>{list.map((t) => (
            <tr key={t.id}><td>{tgl(t.created_at)}</td><td className="mono">{t.user_id}</td><td><Badge tone={trxTone(t.type)}>{trxLabel(t.type)}</Badge></td>
              <td className={`right ${t.amount >= 0 ? 'pos' : ''}`}><b>{t.amount >= 0 ? '+' : '−'}{rp(Math.abs(t.amount))}</b></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

/* ================= Akun web ================= */
function AccountsTab() {
  const { me } = useMe();
  const { toast, confirm } = useUi();
  const [rows, setRows] = useState(null);
  const load = () => api('/admin/accounts').then((d) => setRows(d.accounts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))))).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  async function del(u) {
    if (!(await confirm({ title: `Hapus akun "${u}"?`, body: 'Akun web dihapus dan user ter-logout. Saldo & riwayat TIDAK terhapus (akun yang tertaut Telegram bisa daftar ulang). Tercatat di log aktivitas.', danger: true, ok: 'Hapus akun' }))) return;
    try { await api(`/admin/accounts/${u}`, { method: 'DELETE' }); toast(`Akun ${u} dihapus.`); load(); } catch (e) { toast(e.message, 'bad'); }
  }
  if (!rows) return <Loading />;
  return (
    <div className="card">
      {rows.length === 0 ? <Empty icon={UserCog} title="Belum ada akun web" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Username</th><th>ID user</th><th>Jenis</th><th>Dibuat</th><th /></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.username}><td><b>{a.username}</b></td><td className="mono">{userLabel(a.telegram_id)}</td><td><Badge tone={a.web_only ? '' : 'info'}>{a.web_only ? 'Website' : 'Tertaut Telegram'}</Badge></td><td>{tgl(a.created_at)}</td>
              <td className="right">{a.username !== me.username && <button className="btn danger ghost sm" onClick={() => del(a.username)}><Trash2 size={13} /> Hapus</button>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="hint">Reset password user tersedia di tab User → klik user.</p>
    </div>
  );
}

/* ================= Broadcast ================= */
function BroadcastTab() {
  const { toast, confirm } = useUi();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  async function send(e) {
    e.preventDefault();
    if (!(await confirm({ title: 'Kirim broadcast?', body: <>Pesan akan dikirim ke <b>semua user bot</b>. Tidak bisa dibatalkan.<pre className="mono small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>{msg}</pre></>, ok: 'Kirim sekarang' }))) return;
    setBusy(true);
    try { const r = await api('/admin/broadcast', { method: 'POST', body: { message: msg } }); toast(`Sedang dikirim ke ${r.targets} user. Laporan dikirim bot ke Telegram Anda.`); setMsg(''); }
    catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }
  return (
    <form className="card" onSubmit={send}>
      <h2>Broadcast ke semua user bot Telegram</h2>
      <p className="small muted">Mendukung Markdown Telegram: <code>*tebal*</code>, <code>_miring_</code>, <code>`kode`</code>. Kalau format salah, dikirim sebagai teks biasa.</p>
      <textarea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={4000} placeholder="Tulis pengumuman…" required style={{ fontFamily: 'inherit' }} />
      <div className="row between mt-s"><span className="hint">{msg.length}/4000</span>
        <button className="btn" disabled={busy || !msg.trim()}>{busy ? <span className="spinner" /> : <Megaphone size={16} />} Kirim</button></div>
    </form>
  );
}

/* ================= Log aktivitas admin ================= */
const ACTION = {
  login: ['Login', 'ok'], login_gagal: ['Login gagal', 'bad'], saldo_tambah: ['Tambah saldo', 'info'],
  saldo_kurang: ['Kurangi saldo', 'warn'], akun_hapus: ['Hapus akun', 'bad'], akun_reset_password: ['Reset password', 'warn'],
  broadcast: ['Broadcast', 'info'], backup_unduh: ['Unduh backup', 'warn'], pengaturan: ['Pengaturan', 'info'], blokir: ['Blokir user', 'bad'], buka_blokir: ['Buka blokir', 'ok'], deposit_cek: ['Cek deposit', ''], deposit_hapus: ['Hapus deposit', 'bad']
};
function LogTab() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const load = (query = q) => api(`/admin/log?q=${encodeURIComponent(query)}`).then((d) => setRows(d.log)).catch(() => setRows([]));
  useEffect(() => { load(''); }, []);
  return (
    <div className="card">
      <form className="input-group" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <div className="input-icon" style={{ flex: 1 }}><Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari admin, aksi, user, atau IP" /></div>
        <button className="btn">Cari</button>
      </form>
      {!rows ? <Loading /> : rows.length === 0 ? <Empty icon={ScrollText} title="Belum ada aktivitas" /> : (
        <div className="table-wrap mt"><table>
          <thead><tr><th>Waktu</th><th>Admin</th><th>Aksi</th><th>Detail</th><th>IP</th></tr></thead>
          <tbody>{rows.map((e, i) => (
            <tr key={i}><td>{tgl(e.at)}</td><td><b>{e.admin}</b></td><td><StatusBadge map={ACTION} value={e.action} /></td>
              <td className="wrap small">{e.detail}</td><td className="mono small">{e.ip}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="hint">Semua tindakan admin (login, ubah saldo, reset password, hapus, broadcast, unduh backup) tercatat permanen dan ikut dicadangkan.</p>
    </div>
  );
}

/* ================= Pengaturan: harga, maintenance, iklan ================= */
function SettingsTab() {
  const { toast, confirm } = useUi();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/admin/settings').then(setS).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, []);
  async function save(body, msg) {
    setBusy(true);
    try { await api('/admin/settings', { method: 'POST', body }); toast(msg); load(); } catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }
  if (!s) return <Loading />;
  const toggleMaint = async () => {
    const on = !s.maintenance.on;
    if (!(await confirm({ title: on ? 'Aktifkan maintenance?' : 'Matikan maintenance?', body: on
      ? 'Install RDP, deposit, dan buat droplet DIHENTIKAN untuk semua user (web & bot Telegram). Instalasi yang sedang berjalan tetap lanjut. Admin tetap bisa memakai semua fitur.'
      : 'Semua layanan kembali normal.', danger: on }))) return;
    save({ maintenance: { on, message: s.maintenance.message } }, on ? 'Maintenance aktif.' : 'Maintenance dimatikan.');
  };
  return (<>
    <form className="card" onSubmit={(e) => { e.preventDefault(); save({ installCost: s.installCost, vpsCreateCost: s.vpsCreateCost }, 'Harga disimpan — langsung berlaku di web & bot.'); }}>
      <h2>Harga layanan</h2>
      <p className="small muted" style={{ margin: '4px 0 0' }}>Berlaku langsung untuk website <b>dan</b> bot Telegram. Instalasi yang sudah berjalan memakai harga saat dimulai.</p>
      <div className="grid grid-2 mt-s">
        <div><label>Install RDP (per VPS)</label>
          <input inputMode="numeric" value={s.installCost} onChange={(e) => setS({ ...s, installCost: e.target.value.replace(/\D/g, '') })} required /></div>
        <div><label>Buat droplet DigitalOcean (per batch)</label>
          <input inputMode="numeric" value={s.vpsCreateCost} onChange={(e) => setS({ ...s, vpsCreateCost: e.target.value.replace(/\D/g, '') })} required /></div>
      </div>
      <button className="btn mt" disabled={busy}>Simpan harga</button>
    </form>

    <div className="card">
      <div className="row between">
        <div><h2><Wrench size={16} style={{ verticalAlign: -2 }} /> Mode maintenance</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Hentikan sementara install, deposit, dan buat droplet saat server bermasalah. Saldo user tetap aman.</p></div>
        <Badge tone={s.maintenance.on ? 'warn' : 'ok'}>{s.maintenance.on ? 'AKTIF' : 'Normal'}</Badge>
      </div>
      <label>Pesan untuk user</label>
      <input value={s.maintenance.message} maxLength={300} onChange={(e) => setS({ ...s, maintenance: { ...s.maintenance, message: e.target.value } })} placeholder="Contoh: Server sedang upgrade, kembali pukul 15.00 WIB." />
      <div className="row mt-s">
        <button className={`btn ${s.maintenance.on ? '' : 'danger'}`} disabled={busy} onClick={toggleMaint}>{s.maintenance.on ? 'Matikan maintenance' : 'Aktifkan maintenance'}</button>
        {s.maintenance.on && <button className="btn ghost" disabled={busy} onClick={() => save({ maintenance: s.maintenance }, 'Pesan maintenance diperbarui.')}>Perbarui pesan</button>}
      </div>
    </div>

    <div className="card">
      <div className="row between">
        <div><h2><AdIcon size={16} style={{ verticalAlign: -2 }} /> Banner iklan</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Banner Rental Mail & Kado Virtual di dashboard.</p></div>
        <button className="btn ghost" disabled={busy} onClick={() => save({ ads: !s.ads }, s.ads ? 'Iklan disembunyikan.' : 'Iklan ditampilkan.')}>{s.ads ? 'Sembunyikan' : 'Tampilkan'}</button>
      </div>
    </div>

    <div className="card">
      <h2><Ban size={16} style={{ verticalAlign: -2 }} /> User diblokir ({s.blocked.length})</h2>
      {s.blocked.length === 0 ? <p className="small muted">Tidak ada. Blokir user dari tab User → klik user.</p> : (
        <div className="table-wrap mt-s"><table>
          <thead><tr><th>User</th><th>Alasan</th><th>Oleh</th><th>Waktu</th></tr></thead>
          <tbody>{s.blocked.map((b) => <tr key={b.user_id}><td className="mono">{userLabel(b.user_id)}</td><td className="wrap">{b.reason || '-'}</td><td>{b.by}</td><td>{tgl(b.at)}</td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  </>);
}

const PANELS = { overview: Overview, users: UsersTab, deposits: DepositsTab, jobs: JobsTab, inst: InstallsTab, trx: TrxTab, accounts: AccountsTab, broadcast: BroadcastTab, settings: SettingsTab, log: LogTab };

export default function Admin() {
  const { me } = useMe();
  const [tab, setTab] = useState('overview');
  if (!me.admin) return <Alert tone="bad">Halaman ini khusus admin.</Alert>;
  if (!me.adminVerified) {
    return (
      <div className="card center" style={{ maxWidth: 480, margin: '40px auto' }}>
        <ShieldAlert size={44} className="muted" />
        <h2 className="mt">Verifikasi admin diperlukan</h2>
        <p className="muted small">Panel admin hanya bisa dibuka setelah login dengan kode OTP Telegram. Keluar lalu login kembali.</p>
        <button className="btn" onClick={async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; }}>Keluar & login ulang</button>
      </div>
    );
  }
  const Panel = PANELS[tab];
  return (<>
    <div className="page-head"><div><h1>Panel Admin</h1><p>Pantau bisnis, kelola user, saldo, dan deposit. Setiap tindakan tercatat di log aktivitas.</p></div></div>
    <div className="tabs-scroll">
      <div className="segmented" style={{ flexWrap: 'nowrap' }}>
        {TABS.map(([k, l, Icon]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}><Icon size={15} />{l}</button>
        ))}
      </div>
    </div>
    <div className="stack"><Panel /></div>
  </>);
}
