'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard, MonitorDown, Cloud, Wallet, History, CircleHelp, Settings, ShieldCheck, LogOut, Menu, Server
} from 'lucide-react';
import { api, rp, userLabel, MeContext } from '../lib';
import { UiProvider, Loading } from '../ui';

const MENU = [
  ['/', 'Dashboard', LayoutDashboard],
  ['/install', 'Install RDP', MonitorDown],
  ['/do', 'DigitalOcean', Cloud],
  ['/deposit', 'Deposit', Wallet],
  ['/history', 'Riwayat', History],
  ['/faq', 'Bantuan', CircleHelp]
];

export default function AppLayout({ children }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const reload = useCallback(() => api('/me').then((d) => { setMe(d); setErr(''); }).catch((e) => {
    if (e.status === 401) router.replace('/login');
    else setErr(e.message);
  }), [router]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setOpen(false); }, [path]);

  async function logout() {
    await api('/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
  }

  if (!me) {
    return (
      <div className="auth-main" style={{ minHeight: '100vh' }}>
        {err ? (
          <div className="card center" style={{ maxWidth: 420 }}>
            <p>{err}</p>
            <button className="btn" onClick={reload}>Coba lagi</button>
          </div>
        ) : <Loading text="Menghubungkan ke server…" />}
      </div>
    );
  }

  const active = (href) => (href === '/' ? path === '/' : path.startsWith(href));
  const link = ([href, label, Icon]) => (
    <Link key={href} href={href} className={`nav-link ${active(href) ? 'active' : ''}`}>
      <Icon size={18} />{label}
    </Link>
  );
  const brand = (
    <Link href="/" className="brand"><span className="brand-mark"><Server size={18} /></span>RDP Installer</Link>
  );

  return (
    <UiProvider>
      <MeContext.Provider value={{ me, reload }}>
        <div className="shell">
          <aside className={`sidebar ${open ? 'open' : ''}`}>
            {brand}
            <div className="nav-label">Menu</div>
            {MENU.map(link)}
            <div className="nav-label">Akun</div>
            {link(['/akun', 'Pengaturan', Settings])}
            {me.admin && link(['/admin', 'Panel Admin', ShieldCheck])}
            <div className="sidebar-foot">
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
            </div>
          </aside>
          <div className={`backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
          <div style={{ minWidth: 0 }}>
            <header className="topbar">
              <button className="icon-btn" onClick={() => setOpen(true)} aria-label="Buka menu"><Menu size={18} /></button>
              {brand}
              <Link href="/deposit" className="badge info">{me.admin ? 'Unlimited' : rp(me.balance)}</Link>
            </header>
            <main className="main">{children}</main>
          </div>
        </div>
      </MeContext.Provider>
    </UiProvider>
  );
}
