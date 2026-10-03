'use client';
import { MessageCircle } from 'lucide-react';
import { rp, useMe } from '../../lib';

const LOKAL = ['Nevacloud', 'Flaz VPS', 'Warnahost', 'OrangeVPS', 'Jetorbit', 'IDCloudHost', 'Natanetwork', 'RumahWeb', 'Biznet Neo Virtual Compute', 'Datalix'];
const INTL = ['DigitalOcean', 'LightNode', 'Kuroit', 'OVHcloud', 'Crunchbits', 'HostHatch', 'Hetzner', 'DedicatedCore', 'GreenCloud', 'AkileCloud', 'Ultahost', 'ByteVirt', 'Datawagon', 'Avoro', 'Atlantic.Net', 'Vebble'];

export default function Faq() {
  const { me } = useMe();
  const QA = [
    ['Berapa biaya install RDP?', <>{rp(me.installCost)} per VPS. Saldo ditahan saat instalasi dimulai, lalu <b>dikembalikan otomatis</b> untuk VPS yang gagal, tidak memenuhi syarat, atau terhenti karena server restart.</>],
    ['Apa syarat VPS-nya?', <>Minimal {me.minSpecs.cpu} core · {me.minSpecs.ram} GB RAM · {me.minSpecs.storage} GB disk kosong, OS fresh install Ubuntu 20.04/22.04/24.04 dengan akses root. Disarankan VPS yang mendukung KVM.</>],
    ['Berapa lama instalasinya?', 'Sekitar 15–45 menit. Setelah selesai, Windows Setup masih berjalan 10–60 menit di dalam VPS. Tunggu sampai selesai sebelum connect RDP.'],
    ['Bagaimana cara connect RDP?', <>Buka Remote Desktop (Windows) atau Microsoft Remote Desktop (HP), masukkan IP VPS, username <code>admin</code>, dan password RDP yang Anda buat.</>],
    ['Apa itu link monitor :8006?', <>Link <code>http://IP:8006</code> menampilkan layar Windows saat dipasang. Pesan &quot;NoVNC encountered an error&quot; itu normal saat Windows restart — muat ulang saja.</>],
    ['Aturan password?', <>RDP Windows: huruf + angka, minimal 8, tanpa simbol (contoh <code>Fauzi2024</code>). Root droplet DO: wajib simbol + huruf besar/kecil + angka, diakhiri huruf (contoh <code>@Mbahfauzi2025x</code>).</>],
    ['Multi install itu apa?', 'Pasang RDP ke maksimal 10 VPS sekaligus. Satu baris = satu VPS (IP PASSWORD). Ditagih hanya untuk VPS yang berhasil.'],
    ['Control DigitalOcean aman?', <>Token DigitalOcean Anda hanya disimpan di tab browser ini dan tidak disimpan di server. Semua fitur gratis kecuali buat droplet ({rp(me.vpsCreateCost)} flat per batch). Sewa droplet ditagih DigitalOcean ke akun Anda.</>],
    ['Deposit belum masuk?', 'Saldo biasanya masuk dalam hitungan detik. Kalau 2 menit belum masuk, tekan "Cek status" di halaman deposit. Masih belum? Hubungi admin dengan menyebut nomor ref.'],
    ['Akun RDP terkunci?', 'Setelah RDP jadi, set Account lockout threshold = 0 (secpol.msc → Account Policies → Account Lockout Policy) agar akun tidak terkunci karena percobaan login.']
  ];

  return (<>
    <div className="page-head">
      <div><h1>Bantuan & FAQ</h1><p>Jawaban untuk pertanyaan yang paling sering ditanyakan.</p></div>
      <a className="btn" href="https://wa.me/6285173329868" target="_blank" rel="noreferrer"><MessageCircle size={16} /> Chat admin</a>
    </div>
    <div className="split">
      <div className="card">
        {QA.map(([q, a]) => (
          <details key={q} className="list-item" style={{ display: 'block' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{q}</summary>
            <p className="small" style={{ margin: '8px 0 0', color: 'var(--text-2)' }}>{a}</p>
          </details>
        ))}
      </div>
      <div className="card">
        <h2>Rekomendasi VPS</h2>
        <p className="hint">Support KVM · min. 2 core · 4 GB RAM · 40 GB disk · Ubuntu 22.04</p>
        <div className="nav-label" style={{ padding: '12px 0 6px' }}>Lokal</div>
        <div className="chips">{LOKAL.map((p) => <span key={p} className="badge">{p}</span>)}</div>
        <div className="nav-label" style={{ padding: '14px 0 6px' }}>Internasional</div>
        <div className="chips">{INTL.map((p) => <span key={p} className="badge">{p}</span>)}</div>
      </div>
    </div>
  </>);
}
