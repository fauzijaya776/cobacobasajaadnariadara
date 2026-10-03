'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard, MonitorDown, Cloud, Wallet, History, CircleHelp, Settings, LogOut, Menu, Server, TerminalSquare, LogIn, UserPlus, Lock, Wrench
} from 'lucide-react';
import { api, rp, userLabel, MeContext } from '../lib';
import { UiProvider, Loading } from '../ui';

const MENU = [
  ['/', 'Dashboard', LayoutDashboard],
  ['/install', 'Install RDP', MonitorDown],
  ['/do', 'DigitalOcean', Cloud],
  ['/ssh', 'SSH Online', TerminalSquare],
  ['/deposit', 'Deposit', Wallet],
  ['/history', 'Riwayat', History],
  ['/faq', 'Bantuan', CircleHelp]
];
// Halaman yang boleh dilihat tamu. Selain ini, tamu diminta login dulu.
const PUBLIC = ['/', '/faq'];

function LoginGate({ path }) {
  const next = encodeURIComponent(path);
  return (
    <div className="card center" style={{ maxWidth: 460, margin: '48px auto' }}>
      <span className="stat-icon" style={{ margin: '0 auto', width: 52, height: 52 }}><Lock size={24} /></span>
      <h2 className="mt">Masuk untuk memakai fitur ini</h2>
      <p className="muted small">Daftar gratis cukup dengan username dan password. Setelah masuk, Anda langsung kembali ke halaman ini.</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <Link href={`/login?next=${next}`} className="btn"><LogIn size={16} /> Masuk</Link>
        <Link href={`/register?next=${next}`} className="btn ghost"><UserPlus size={16} /> Daftar</Link>
      </div>
    </div>
  );
}

export default function AppLayout({ children }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState(undefined);   // undefined = memuat, null = tamu
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const reload = useCallback(() => api('/me').then((d) => { setMe(d); setErr(''); }).catch((e) => {
    if (e.status === 401) setMe(null);
    else setErr(e.message);
  }), []);

  useEffect(() => {
    reload();
    api('/info').then(setInfo).catch(() => {});
  }, [reload]);
  useEffect(() => { setOpen(false); }, [path]);

  async function logout() {
    await api('/logout', { method: 'POST' }).catch(() => {});
    setMe(null);
    router.replace('/');
  }

  if (me === undefined || (!info && !err)) {
    return (
      <div className="auth-main" style={{ minHeight: '100vh' }}>
        {err ? (
          <div className="card center" style={{ maxWidth: 420 }}>
            <p>{err}</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn" onClick={() => { setErr(''); reload(); api('/info').then(setInfo).catch(() => {}); }}>Coba lagi</button>
              <button className="btn ghost" onClick={async () => { await api('/logout', { method: 'POST' }).catch(() => {}); setErr(''); setMe(null); }}>Keluar</button>
            </div>
          </div>
        ) : <Loading text="Menghubungkan ke server…" />}
      </div>
    );
  }

  const active = (href) => (href === '/' ? path === '/' : path.startsWith(href));
  const link = ([href, label, Icon]) => (
    <Link key={href} href={href} className={`nav-link ${active(href) ? 'active' : ''}`}>
      <Icon size={18} />{label}
      {!me && !PUBLIC.includes(href) && <Lock size={13} style={{ marginLeft: 'auto', opacity: 0.45 }} />}
    </Link>
  );
  const brand = (
    <Link href="/" className="brand"><span className="brand-mark"><Server size={18} /></span>RDP Installer</Link>
  );
  const gated = !me && !PUBLIC.includes(path);

  return (
    <UiProvider>
      <MeContext.Provider value={{ me, info: info || {}, reload }}>
        <div className="shell">
          <aside className={`sidebar ${open ? 'open' : ''}`}>
            {brand}
            <div className="nav-label">Menu</div>
            {MENU.map(link)}
            {me && (<>
              <div className="nav-label">Akun</div>
              {link(['/akun', 'Pengaturan', Settings])}
            </>)}
            <div className="sidebar-foot">
              {me ? (<>
                <div className="balance-chip">
                  <div className="label">Saldo</div>
                  <div className="value">{me.admin ? 'Unlimited' : rp(me.balance)}</div>
                  {me.held > 0 && <div className="label">{rp(me.held)} ditahan untuk instalasi</div>}
                  <Link href="/deposit" className="btn sm block mt-s">+ Deposit</Link>
                </div>
                <div className="user-row">
                  <span className="avatar">{me.username[0]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="name">{me.username}</div>
                    <div className="sub">{me.admin ? 'Admin' : me.webOnly ? 'Akun web' : `ID ${userLabel(me.telegram_id)}`}</div>
                  </div>
                  <button className="icon-btn" onClick={logout} aria-label="Keluar" title="Keluar"><LogOut size={16} /></button>
                </div>
              </>) : (
                <div className="balance-chip">
                  <div className="label">Belum masuk</div>
                  <div className="small">Daftar gratis untuk mulai install RDP.</div>
                  <Link href={`/register?next=${encodeURIComponent(path)}`} className="btn sm block mt-s"><UserPlus size={14} /> Daftar</Link>
                  <Link href={`/login?next=${encodeURIComponent(path)}`} className="btn ghost sm block mt-s"><LogIn size={14} /> Masuk</Link>
                </div>
              )}
            </div>
          </aside>
          <div className={`backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
          <div style={{ minWidth: 0 }}>
            <header className="topbar">
              <button className="icon-btn" onClick={() => setOpen(true)} aria-label="Buka menu"><Menu size={18} /></button>
              {brand}
              {me
                ? <Link href="/deposit" className="badge info">{me.admin ? 'Unlimited' : rp(me.balance)}</Link>
                : <Link href={`/login?next=${encodeURIComponent(path)}`} className="btn sm">Masuk</Link>}
            </header>
            {info?.maintenance && (
              <div className="maint-bar"><Wrench size={16} /><span><b>Sedang maintenance:</b> {info.maintenance} Install, deposit, dan buat droplet dihentikan sementara.</span></div>
            )}
            <main className="main">{gated ? <LoginGate path={path} /> : children}</main>
          </div>
        </div>
      </MeContext.Provider>
    </UiProvider>
  );
}
