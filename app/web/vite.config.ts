import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // The config lives beside index.html, so root must point at this directory
  // rather than the repo root the command is run from.
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // The BFF holds the TrueForge token and the long-running scan stream.
    proxy: { '/api': { target: 'http://127.0.0.1:8791', changeOrigin: true } },
  },
});
