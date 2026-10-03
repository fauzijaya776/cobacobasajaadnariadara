'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ExternalLink, Undo2, CheckCircle2 } from 'lucide-react';
import { api, rp, tgl, useMe, usePoll, JOB_STATUS } from '../../../lib';
import { Alert, Badge, CopyButton, Loading, Progress, StatusBadge } from '../../../ui';

export default function Job() {
  const { id } = useParams();
  const { reload } = useMe();
  const [job, setJob] = useState(null);
  const [err, setErr] = useState('');

  const running = !job || job.status === 'running';
  usePoll(() => api(`/jobs/${id}`).then((j) => {
    setJob(j);
    if (j.status === 'done') reload();
  }).catch((e) => setErr(e.message)), 5000, running && !err);

  if (err) return <Alert tone="bad">{err} <Link href="/history">Lihat riwayat instalasi</Link></Alert>;
  if (!job) return <Loading />;

  const ok = job.items.filter((s) => s.status === 'success').length;
  const refunded = job.items.filter((s) => s.refunded).length;

  return (<>
    <div className="page-head">
      <div>
        <h1>{job.kind === 'install' ? `Install ${job.title}` : 'Buat droplet DigitalOcean'}</h1>
        <p>Dimulai {tgl(job.created_at)}</p>
      </div>
      <Badge tone={job.status === 'running' ? 'warn' : 'ok'}>{job.status === 'running' ? 'Sedang berjalan' : 'Selesai'}</Badge>
    </div>

    {job.kind === 'install' && (<>
      {job.status === 'running'
        ? <Alert tone="info">Halaman diperbarui otomatis. Anda boleh menutupnya — proses tetap jalan di server.</Alert>
        : <Alert tone={ok ? 'ok' : 'bad'}>
            <b>{ok} dari {job.items.length} VPS berhasil.</b>
            {job.prepaid && refunded > 0 && <> {rp(refunded * job.cost)} sudah dikembalikan ke saldo Anda.</>}
          </Alert>}

      <div className="grid grid-2 mt">
        {job.items.map((s) => (
          <div className="card" key={s.ip}>
            <div className="card-head" style={{ marginBottom: 10 }}>
              <h3 className="mono">{s.ip}</h3>
              <StatusBadge map={JOB_STATUS} value={s.status} />
            </div>

            {(s.status === 'installing' || s.status === 'checking' || s.status === 'queued') && (<>
              <Progress value={s.status === 'installing' ? s.percent : 2} />
              <div className="row between mt-s small muted"><span>{s.note || (s.status === 'checking' ? 'Memeriksa VPS' : 'Menunggu giliran')}</span><span>{s.status === 'installing' ? `${s.percent}%` : ''}</span></div>
              {s.status === 'installing' && s.percent >= 10 && (
                <a className="btn ghost sm mt" href={`http://${s.ip}:8006`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Lihat layar instalasi</a>
              )}
            </>)}

            {(s.status === 'failed' || s.status === 'skipped') && (<>
              <p className="small" style={{ color: 'var(--bad)', margin: '0 0 8px' }}>{s.note}</p>
              {s.refunded && <Badge tone="ok"><Undo2 size={12} /> {rp(job.cost)} dikembalikan</Badge>}
            </>)}

            {s.status === 'success' && (<>
              <dl className="kv">
                <dt>IP</dt><dd className="mono">{s.ip}<CopyButton text={s.ip} /></dd>
                <dt>Username</dt><dd className="mono">admin<CopyButton text="admin" /></dd>
                <dt>Password</dt><dd>password RDP yang Anda buat</dd>
              </dl>
              <div className="row mt">
                <a className="btn sm" href={`http://${s.ip}:8006`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Monitor Windows Setup</a>
              </div>
              <p className="hint"><CheckCircle2 size={12} style={{ verticalAlign: -2 }} /> Tunggu Windows Setup selesai (10–60 menit) sebelum connect lewat Remote Desktop.</p>
            </>)}
          </div>
        ))}
      </div>
    </>)}

    {job.kind === 'do_create' && (
      <div className="card">
        <dl className="kv">
          <dt>User</dt><dd className="mono">root<CopyButton text="root" /></dd>
          <dt>Password</dt><dd className="mono">{job.rootPassword}<CopyButton text={job.rootPassword} /></dd>
        </dl>
        <div className="table-wrap mt"><table>
          <thead><tr><th>Nama</th><th>Status</th><th>IP publik</th></tr></thead>
          <tbody>{(job.droplets || []).map((d) => (
            <tr key={d.id}>
              <td>{d.name || d.id}</td>
              <td><Badge tone={d.ip ? 'ok' : 'warn'}>{d.ip ? 'Aktif' : d.status || 'Menyiapkan'}</Badge></td>
              <td className="mono">{d.ip ? <span className="row" style={{ gap: 6 }}>{d.ip}<CopyButton text={d.ip} /></span> : 'menunggu…'}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {job.error && <div className="mt"><Alert tone="bad">{job.error}</Alert></div>}
        <div className="mt"><Alert tone="warn">Simpan password ini — tidak bisa dilihat lagi setelah server restart. Password root aktif ±1–2 menit setelah droplet menyala.</Alert></div>
        <Link href="/install" className="btn mt">Install RDP ke droplet ini</Link>
      </div>
    )}
  </>);
}
