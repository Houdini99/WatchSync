import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During local dev (`npm run dev`) the API and WebSocket are proxied to the
// Rust server on :3000. In production these paths are served by Nginx, which
// reverse-proxies them to the server container — see frontend/nginx.conf.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 127.0.0.1, not localhost: avoids resolving to IPv6 (::1) and missing an
      // IPv4-bound dev server.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // No inlined module-preload polyfill, so a strict `script-src 'self'` CSP
    // (see frontend/nginx.conf) has no inline script to block.
    modulePreload: { polyfill: false },
    // HLS.js is a deliberately large, lazily-loaded chunk (only fetched when an
    // .m3u8 stream plays) — don't warn about it.
    chunkSizeWarningLimit: 700,
  },
});
