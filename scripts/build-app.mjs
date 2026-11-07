// Copies the game into www/ for the Play Store and App Store builds (Capacitor).
// Usage: SERVER_URL=https://your-server.onrender.com npm run build:app
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const server = (process.env.SERVER_URL || '').replace(/\/$/, '');

if (!/^https:\/\//.test(server)) {
  console.error('Set SERVER_URL to your deployed game server, for example:\n  SERVER_URL=https://crateyard.onrender.com npm run build:app');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'client'), out, { recursive: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/three/build/three.min.js'), path.join(out, 'vendor/three.min.js'));
fs.writeFileSync(path.join(out, 'config.js'), `window.CRATEYARD_SERVER = ${JSON.stringify(server)};\n`);
fs.rmSync(path.join(out, 'sw.js'), { force: true }); // the store apps ship their files, so no offline cache is needed

console.log(`Built www/ for the store apps, talking to ${server}`);
