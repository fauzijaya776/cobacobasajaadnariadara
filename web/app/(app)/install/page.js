'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MonitorDown, Layers, Search, Cpu, MemoryStick, HardDrive, Monitor, Server, Rocket, Eye, EyeOff } from 'lucide-react';
import { api, rp, useMe } from '../../lib';
import { Alert, Loading, Segmented, useUi } from '../../ui';

// Sama dengan aturan bot (src/utils/password.js).
const RDP_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,64}$/;

/** Hitung VPS unik dari teks multi-install (sama seperti server: baris kosong & IP kembar dilewati). */
function parseLines(text) {
  const ips = new Set();
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [target, ...pw] = t.split(/\s+/);
    const ip = (target.match(/(?:\d{1,3}\.){3}\d{1,3}/) || [])[0];
    if (!ip || !pw.length) { bad++; continue; }
    ips.add(ip);
  }
  return { count: ips.size, bad };
}

function Steps({ step }) {
  const items = ['VPS', 'Windows', 'Password'];
  return (
    <div className="steps">
      {items.map((t, i) => (<span key={t} className="row" style={{ gap: 8 }}>
        {i > 0 && <span className="step-sep" />}
        <span className={`step ${step === i ? 'active' : step > i ? 'done' : ''}`}><span className="n">{i + 1}</span>{t}</span>
      </span>))}
    </div>
  );
}

export default function Install() {
  const { me, reload } = useMe();
  const { confirm } = useUi();
  const router = useRouter();
  const [mode, setMode] = useState('single');
  const [info, setInfo] = useState(null);
  const [target, setTarget] = useState({ ip: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [lines, setLines] = useState('');
  const [check, setCheck] = useState(null);
  const [windowsId, setWindowsId] = useState(null);
  const [rdpPassword, setRdpPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (new URLSearchParams(location.search).has('multi')) setMode('multi');
    api('/windows').then(setInfo).catch((e) => setErr(e.message));
  }, []);

  const multi = mode === 'multi';
  const parsed = useMemo(() => parseLines(lines), [lines]);
  const count = multi ? parsed.count : 1;
  const total = me.installCost * count;
  const vpsReady = multi ? parsed.count > 0 && parsed.count <= (info?.maxTargets || 10) : check && check.problems.length === 0;
  const step = !vpsReady ? 0 : !windowsId ? 1 : 2;
  const pwOk = RDP_RE.test(rdpPassword);
  const enough = me.admin || me.balance >= total;

  function switchMode(m) { setMode(m); setErr(''); setWindowsId(null); }

  async function doCheck(e) {
    e.preventDefault();
    setBusy('check'); setErr(''); setCheck(null); setWindowsId(null);
    try { setCheck(await api('/install/check', { method: 'POST', body: { target: target.ip.trim(), password: target.password } })); }
    catch (e) { setErr(e.message); }
    setBusy('');
  }

  async function start() {
    const v = info.versions.find((x) => x.id === windowsId);
    const ok = await confirm({
      title: 'Mulai instalasi?',
      ok: 'Mulai install',
      body: (<div className="summary">
        <div className="line"><span>Windows</span><b>{v.name}</b></div>
        <div className="line"><span>Jumlah VPS</span><b>{count}</b></div>
        <div className="line"><span>Password RDP</span><b className="mono">{rdpPassword}</b></div>
        <div className="line total"><span>Saldo ditahan</span><span>{me.admin ? 'Gratis (admin)' : rp(total)}</span></div>
        <p className="small muted" style={{ margin: 0 }}>VPS yang gagal atau dilewati otomatis di-refund. Data di VPS akan ditimpa Windows.</p>
      </div>)
    });
    if (!ok) return;
    setBusy('start'); setErr('');
    try {
      const user = target.ip.includes('@') ? target.ip.split('@')[0] + '@' : '';
      const body = {
        windowsId, rdpPassword,
        lines: multi ? lines : `${user}${check.ip}:${check.port} ${target.password}`
      };
      const r = await api('/install', { method: 'POST', body });
      reload();
      router.push(`/job/${r.jobId}`);
    } catch (e) { setErr(e.message); setBusy(''); }
  }

  if (!info) return err ? <Alert tone="bad">{err}</Alert> : <Loading />;

  const compatible = (v) => multi || !check || check.compatible.includes(v.id);

  return (<>
    <div className="page-head">
      <div><h1>Install RDP Windows</h1><p>Ubah VPS Ubuntu menjadi RDP Windows. Estimasi 15–45 menit.</p></div>
      <Segmented value={mode} onChange={switchMode} options={[['single', 'Satu VPS', MonitorDown], ['multi', `Multi VPS (maks ${info.maxTargets})`, Layers]]} />
    </div>

    {me.installing && <div style={{ marginBottom: 16 }}><Alert tone="warn">Masih ada instalasi Anda yang berjalan. Tunggu selesai sebelum memulai yang baru.</Alert></div>}

    <div className="split">
      <div className="stack">
        <Steps step={step} />

        {!multi ? (
          <form className="card" onSubmit={doCheck}>
            <div className="card-head"><div><h2>1. Data VPS</h2><p>Kami cek spesifikasi & KVM dulu. Pengecekan gratis.</p></div></div>
            <div className="grid grid-2">
              <div>
                <label htmlFor="ip" style={{ marginTop: 0 }}>IP VPS</label>
                <input id="ip" value={target.ip} onChange={(e) => { setTarget({ ...target, ip: e.target.value }); setCheck(null); }} placeholder="123.45.67.89" required />
                <div className="hint">Port lain: <code>IP:PORT</code> · user lain: <code>user@IP</code></div>
              </div>
              <div>
                <label htmlFor="vpw" style={{ marginTop: 0 }}>Password root VPS</label>
                <div className="input-group">
                  <input id="vpw" type={showPw ? 'text' : 'password'} value={target.password} onChange={(e) => { setTarget({ ...target, password: e.target.value }); setCheck(null); }} autoComplete="off" required />
                  <button type="button" className="icon-btn" style={{ height: 'auto', width: 42 }} onClick={() => setShowPw(!showPw)} aria-label="Tampilkan password">{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </div>
              </div>
            </div>
            <button className="btn mt" disabled={!!busy}>{busy === 'check' ? <><span className="spinner" /> Memeriksa VPS… (maks ±1 menit)</> : <><Search size={16} /> Cek VPS</>}</button>

            {check && (
              <div className="mt">
                <div className="grid grid-3">
                  <div className="stat"><div className="stat-icon info"><Cpu size={18} /></div><div><div className="label">CPU</div><div className="value" style={{ fontSize: 17 }}>{check.allocation.cpu} core</div></div></div>
                  <div className="stat"><div className="stat-icon info"><MemoryStick size={18} /></div><div><div className="label">RAM</div><div className="value" style={{ fontSize: 17 }}>{check.allocation.ram} GB</div></div></div>
                  <div className="stat"><div className="stat-icon info"><HardDrive size={18} /></div><div><div className="label">Disk Windows</div><div className="value" style={{ fontSize: 17 }}>{check.allocation.storage} GB</div></div></div>
                </div>
                <div className="mt">
                  {check.problems.length > 0
                    ? <Alert tone="bad"><b>VPS belum memenuhi syarat:</b> {check.problems.join(' · ')}. Saldo tidak dipotong.</Alert>
                    : check.kvm
                      ? <Alert tone="ok">VPS mendukung KVM — performa optimal. Port SSH {check.port}{check.isArm ? ` · ARM (${check.arch})` : ''}.</Alert>
                      : <Alert tone="warn">VPS tidak mendukung KVM. Instalasi tetap bisa, tapi Windows akan terasa lebih lambat.</Alert>}
                </div>
              </div>
            )}
          </form>
        ) : (
          <div className="card">
            <div className="card-head"><div><h2>1. Daftar VPS</h2><p>Satu baris = satu VPS. Spesifikasi dicek per VPS saat instalasi.</p></div></div>
            <textarea value={lines} onChange={(e) => setLines(e.target.value)} placeholder={'1.2.3.4 passwordVps1\n5.6.7.8:2222 passwordVps2\nubuntu@9.9.9.9 passwordVps3'} />
            <div className="row mt-s small">
              <span className={parsed.count ? 'pos' : 'muted'}>{parsed.count} VPS terdeteksi</span>
              {parsed.bad > 0 && <span style={{ color: 'var(--bad)' }}>· {parsed.bad} baris tidak valid (format: IP PASSWORD)</span>}
              {parsed.count > info.maxTargets && <span style={{ color: 'var(--bad)' }}>· maksimal {info.maxTargets} VPS</span>}
            </div>
          </div>
        )}

        {vpsReady && (
          <div className="card">
            <div className="card-head"><div><h2>2. Pilih versi Windows</h2>
              <p>{multi ? 'VPS yang tidak cukup untuk versi ini akan dilewati & di-refund.' : 'Hanya versi yang muat di VPS Anda yang bisa dipilih.'}</p></div></div>
            {['desktop', 'server'].map((cat) => (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div className="nav-label" style={{ padding: '0 0 8px' }}>{cat === 'desktop' ? 'Desktop' : 'Server'}</div>
                <div className="os-grid">
                  {info.versions.filter((v) => v.category === cat).map((v) => {
                    const okv = compatible(v);
                    return (
                      <button type="button" key={v.id} disabled={!okv} className={`os ${windowsId === v.id ? 'active' : ''}`} onClick={() => setWindowsId(v.id)}>
                        <span className="stat-icon" style={{ width: 34, height: 34 }}>{cat === 'desktop' ? <Monitor size={16} /> : <Server size={16} />}</span>
                        <span><span className="t">{v.name}</span><br /><span className="d">{okv ? `min ${v.minRam} GB RAM · ${v.minDisk} GB` : `Butuh ${v.minRam} GB RAM · ${v.minDisk} GB`}</span></span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {vpsReady && windowsId && (
          <div className="card">
            <div className="card-head"><div><h2>3. Password RDP</h2><p>Login RDP memakai username <b>admin</b> dan password ini.</p></div></div>
            <label htmlFor="rpw" style={{ marginTop: 0 }}>Password RDP</label>
            <input id="rpw" value={rdpPassword} onChange={(e) => setRdpPassword(e.target.value.replace(/\s/g, ''))} placeholder="contoh: Fauzi2024" autoComplete="off" />
            <div className={`hint ${rdpPassword && !pwOk ? '' : ''}`} style={rdpPassword && !pwOk ? { color: 'var(--bad)' } : undefined}>{info.rdpRule}.</div>
          </div>
        )}

        {err && <Alert tone="bad">{err}</Alert>}
      </div>

      <div className="card sticky">
        <h2>Ringkasan</h2>
        <div className="summary mt">
          <div className="line"><span>Harga per VPS</span><span>{rp(me.installCost)}</span></div>
          <div className="line"><span>Jumlah VPS</span><span>{count}</span></div>
          <div className="line"><span>Windows</span><span>{windowsId ? info.versions.find((v) => v.id === windowsId).name : '-'}</span></div>
          <div className="line total"><span>Total</span><span>{me.admin ? 'Gratis' : rp(total)}</span></div>
          <div className="line"><span>Saldo Anda</span><span className={enough ? '' : 'neg'}>{me.admin ? 'Unlimited' : rp(me.balance)}</span></div>
        </div>
        {!enough && <div className="mt"><Alert tone="warn">Saldo kurang {rp(total - me.balance)}. <a href="/deposit">Deposit dulu</a>.</Alert></div>}
        <button className="btn block mt" onClick={start} disabled={step < 2 || !pwOk || !enough || me.installing || !!busy}>
          {busy === 'start' ? <span className="spinner" /> : <Rocket size={17} />} Mulai Install
        </button>
        <p className="hint">Saldo ditahan saat mulai dan <b>dikembalikan otomatis</b> untuk VPS yang gagal. Halaman boleh ditutup, proses tetap jalan.</p>
      </div>
    </div>
  </>);
}
