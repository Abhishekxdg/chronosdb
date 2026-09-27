// `npm run build` writes dist/, which build.rs embeds in the chronos binary (see src/studio.rs).
// The Studio's CSP allows only this origin's files: no inline scripts or styles, no data: URLs.
//
// Development: run `chronos studio <folder> --no-open`, then
//   STUDIO=http://127.0.0.1:<its port> npm run dev
// and open http://localhost:5173/#t=<the token it printed>. API calls are proxied to it, with the
// Origin it expects.
import { defineConfig } from 'vite';

const studio = process.env.STUDIO || 'http://127.0.0.1:7071';

export default defineConfig({
  base: './',
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    proxy: {
      '/studio/api': {
        target: studio,
        changeOrigin: true, // Host: the studio's own address
        headers: { Origin: studio }, // and the Origin it accepts
      },
    },
  },
});
