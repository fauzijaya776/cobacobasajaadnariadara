import './globals.css';

export const metadata = {
  title: 'RDP Installer',
  description: 'Install RDP Windows ke VPS Ubuntu, deposit QRIS, dan kelola droplet DigitalOcean.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
