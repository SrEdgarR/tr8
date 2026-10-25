import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  publicDir: false,
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  preview: { host: '127.0.0.1', port: 5188, strictPort: true },
  worker: { format: 'es' },
  build: {
    outDir: 'test-results/finance-6b3-browser',
    emptyOutDir: true,
    sourcemap: false,
    manifest: true,
    rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) },
  },
});
