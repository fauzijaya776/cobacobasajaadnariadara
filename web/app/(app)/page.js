'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MonitorDown, Layers, Cloud, Wallet, ArrowRight, Activity, Receipt, ShieldCheck, TerminalSquare, Undo2, Zap, UserPlus, LogIn } from 'lucide-react';
import { api, rp, tgl, useMe, usePoll, trxLabel, JOB_STATUS } from '../lib';
import { Alert, Badge, Empty, Progress } from '../ui';

const ACTIONS = [
  ['/install', MonitorDown, 'Install RDP', 'Pasang Windows ke 1 VPS'],
  ['/install?multi=1', Layers, 'Multi Install', 'Hingga 10 VPS sekaligus'],
  ['/do', Cloud, 'DigitalOcean', 'Buat & kelola droplet'],
  ['/deposit', Wallet, 'Deposit', 'Isi saldo via QRIS']
];

function Member() {
  const { me } = useMe();
  const [jobs, setJobs] = useState(null);
  const [trx, setTrx] = useState(null);

  const running = (jobs || []).some((j) => j.status === 'running');
  usePoll(() => api('/jobs').then((d) => setJobs(d.jobs)).catch(() => setJobs([])), running ? 5000 : 20000);
  useEffect(() => { api('/history').then((d) => setTrx(d.transactions.slice(0, 6))).catch(() => setTrx([])); }, []);

  return (<>
    <div className="page-head">
      <div>
        <h1>Halo, {me.username} 👋</h1>
        <p>Kelola instalasi RDP, droplet, dan saldo Anda dari satu tempat.</p>
      </div>
    </div>

    <div className="hero">
      <div>
        <div className="label">Saldo Anda</div>
        <div className="amount">{me.admin ? 'Unlimited' : rp(me.balance)}</div>
        <div className="sub">
          {me.held > 0 ? `${rp(me.held)} sedang ditahan untuk instalasi · ` : ''}
          {me.webOnly ? 'Isi saldo kapan saja lewat QRIS' : `Saldo sama dengan di bot Telegram (ID ${me.telegram_id})`}
        </div>
      </div>
      <div className="row">
        <Link href="/deposit" className="btn"><Wallet size={17} /> Deposit</Link>
        <Link href="/install" className="btn ghost"><MonitorDown size={17} /> Install RDP</Link>
      </div>
    </div>

    <div className="grid grid-4 mt">
      {ACTIONS.map(([href, Icon, t, d]) => (
        <Link key={href} href={href} className="action">
          <span className="stat-icon"><Icon size={20} /></span>
          <span style={{ flex: 1 }}><span className="t">{t}</span><br /><span className="d">{d}</span></span>
          <ArrowRight size={16} className="muted" />
        </Link>
      ))}
    </div>

    <div className="mt">
      <Alert tone="ok">
        <b>Harga install {rp(me.installCost)} per VPS</b>. Saldo ditahan saat instalasi dimulai,
        dan <b>otomatis dikembalikan</b> untuk VPS yang gagal atau tidak memenuhi syarat.
      </Alert>
    </div>

    <div className="grid grid-2 mt">
      <div className="card">
        <div className="card-head"><h2><Activity size={16} style={{ verticalAlign: -2 }} /> Proses terbaru</h2></div>
        {!jobs ? <div className="skeleton" style={{ height: 80 }} /> : jobs.length === 0 ? (
          <Empty icon={MonitorDown} title="Belum ada proses">Mulai instalasi pertama Anda dari menu Install RDP.</Empty>
        ) : (
          <div className="list">{jobs.slice(0, 5).map((j) => {
            const done = j.items.filter((s) => ['success', 'failed', 'skipped'].includes(s.status)).length;
            const avg = j.items.length ? j.items.reduce((n, s) => n + (s.status === 'installing' ? s.percent : ['success', 'failed', 'skipped'].includes(s.status) ? 100 : 0), 0) / j.items.length : 0;
            return (
              <Link key={j.id} href={`/job/${j.id}`} className="list-item" style={{ color: 'inherit', textDecoration: 'none' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="t">{j.kind === 'install' ? `${j.title} · ${j.items.length} VPS` : `Droplet: ${j.title}`}</div>
                  <div className="d">{tgl(j.created_at)}{j.kind === 'install' && ` · ${done}/${j.items.length} selesai`}</div>
                  {j.status === 'running' && j.kind === 'install' && <div className="mt-s"><Progress value={avg} /></div>}
                </div>
                <Badge tone={j.status === 'running' ? 'warn' : 'ok'}>{j.status === 'running' ? 'Berjalan' : 'Selesai'}</Badge>
              </Link>
            );
          })}</div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2><Receipt size={16} style={{ verticalAlign: -2 }} /> Transaksi terakhir</h2>
          <Link href="/history" className="small">Lihat semua</Link>
        </div>
        {!trx ? <div className="skeleton" style={{ height: 80 }} /> : trx.length === 0 ? (
          <Empty icon={Receipt} title="Belum ada transaksi" />
        ) : (
          <div className="list">{trx.map((t) => (
            <div key={t.id} className="list-item">
              <div><div className="t">{trxLabel(t.type)}</div><div className="d">{tgl(t.created_at)}</div></div>
              <b className={t.amount >= 0 ? 'pos' : ''}>{t.amount >= 0 ? '+' : '−'}{rp(Math.abs(t.amount))}</b>
            </div>
          ))}</div>
        )}
      </div>
    </div>

    <div className="card mt">
      <div className="row"><ShieldCheck size={18} className="muted" />
        <span className="small muted">
          Syarat VPS: minimal {me.minSpecs.cpu} core · {me.minSpecs.ram} GB RAM · {me.minSpecs.storage} GB disk kosong,
          Ubuntu 20.04/22.04/24.04 fresh install, akses root.
        </span>
      </div>
    </div>
  </>);
}

const FEATURES = [
  [MonitorDown, 'Install RDP otomatis', 'Ubah VPS Ubuntu menjadi RDP Windows — XP sampai Server 2025 — cukup isi IP & password.'],
  [Layers, 'Multi install', 'Pasang ke hingga 10 VPS sekaligus, progres per VPS terlihat langsung.'],
  [Undo2, 'Gagal? Saldo kembali', 'Biaya hanya untuk VPS yang berhasil. Yang gagal otomatis di-refund.'],
  [Cloud, 'Kontrol DigitalOcean', 'Buat droplet + cloud-init, resize, rebuild, snapshot, SSH key — dari satu dashboard.'],
  [TerminalSquare, 'SSH online', 'Terminal SSH langsung di browser, tanpa aplikasi tambahan.'],
  [Wallet, 'Deposit QRIS', 'Semua e-wallet & m-banking, saldo masuk otomatis dalam hitungan detik.']
];

/** Tampilan untuk pengunjung yang belum login. */
function Guest() {
  const { info } = useMe();
  return (<>
    <div className="hero" style={{ padding: 32 }}>
      <div style={{ maxWidth: 560 }}>
        <div className="label"><Zap size={14} style={{ verticalAlign: -2 }} /> Mulai dari {rp(info.installCost)} per VPS</div>
        <div className="amount" style={{ fontSize: 30, lineHeight: 1.2, margin: '8px 0' }}>Ubah VPS Ubuntu jadi RDP Windows dalam hitungan menit.</div>
        <div className="sub">Daftar gratis, deposit via QRIS, pilih Windows, selesai. Gagal install? Saldo otomatis kembali.</div>
      </div>
      <div className="row">
        <Link href="/register" className="btn"><UserPlus size={17} /> Daftar gratis</Link>
        <Link href="/login" className="btn ghost"><LogIn size={17} /> Masuk</Link>
      </div>
    </div>

    <div className="grid grid-3 mt">
      {FEATURES.map(([Icon, t, d]) => (
        <div className="card stat" key={t}>
          <div className="stat-icon"><Icon size={20} /></div>
          <div><div style={{ fontWeight: 650 }}>{t}</div><div className="small muted">{d}</div></div>
        </div>
      ))}
    </div>

    <div className="grid grid-4 mt">
      {ACTIONS.map(([href, Icon, t, d]) => (
        <Link key={href} href={href} className="action">
          <span className="stat-icon"><Icon size={20} /></span>
          <span style={{ flex: 1 }}><span className="t">{t}</span><br /><span className="d">{d}</span></span>
          <ArrowRight size={16} className="muted" />
        </Link>
      ))}
    </div>

    <div className="card mt">
      <div className="row between">
        <div className="row"><ShieldCheck size={18} className="muted" />
          <span className="small muted">
            Syarat VPS: minimal {info.minSpecs?.cpu} core · {info.minSpecs?.ram} GB RAM · {info.minSpecs?.storage} GB disk kosong, Ubuntu 20.04/22.04/24.04.
          </span>
        </div>
        <Link href="/faq" className="small">Baca FAQ →</Link>
      </div>
    </div>
  </>);
}

export default function Dashboard() {
  const { me } = useMe();
  return me ? <Member /> : <Guest />;
}
