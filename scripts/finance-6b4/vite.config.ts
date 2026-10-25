import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('../../', import.meta.url)),
  publicDir: false,
  worker: { format: 'es' },
  build: {
    outDir: 'test-results/finance-6b4-browser',
    emptyOutDir: true,
    sourcemap: false,
    manifest: true,
    rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) },
  },
});
