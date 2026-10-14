import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { createTransport } from './public/transport.js';

export default defineConfig(({ mode }) => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const backend = loadEnv(mode, directory, 'VITE_').VITE_CODEX_CONSOLE_BACKEND_URL;
  try {
    if (!backend) throw new Error('Missing backend');
    createTransport(backend);
  } catch { throw new Error('VITE_CODEX_CONSOLE_BACKEND_URL must be a canonical HTTPS origin.'); }
  return {
    root: fileURLToPath(new URL('./plugin', import.meta.url)),
    envDir: directory,
    base: './',
    publicDir: false,
    build: { outDir: '../dist', emptyOutDir: true, license: true },
  };
});
