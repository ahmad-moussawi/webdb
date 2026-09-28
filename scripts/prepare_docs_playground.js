import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const docsPublicDir = path.join(rootDir, 'docs', 'public');
const targetPlaygroundDir = path.join(docsPublicDir, 'playground');
const targetDistDir = path.join(docsPublicDir, 'dist');

// Ensure destination directories exist
fs.mkdirSync(targetPlaygroundDir, { recursive: true });
fs.mkdirSync(targetDistDir, { recursive: true });

// Source files
const distSrc = path.join(rootDir, 'dist', 'webdb.js');
const logoSrc = path.join(rootDir, 'playground', 'logo.svg');

if (fs.existsSync(distSrc)) {
  fs.copyFileSync(distSrc, path.join(targetDistDir, 'webdb.js'));
  console.log('✓ Copied dist/webdb.js -> docs/public/dist/webdb.js');
} else {
  console.warn('! dist/webdb.js not found. Make sure to run "npm run build" first.');
}

if (fs.existsSync(logoSrc)) {
  fs.copyFileSync(logoSrc, path.join(targetPlaygroundDir, 'logo.svg'));
  console.log('✓ Copied playground/logo.svg -> docs/public/playground/logo.svg');
}
