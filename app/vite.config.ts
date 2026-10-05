import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server proxies /api to the Bun signaling server so the client can
// use same-origin relative paths locally and on Vercel alike.
const signaling = process.env.SIGNALING_ORIGIN ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: signaling, changeOrigin: true, ws: true },
    },
  },
});