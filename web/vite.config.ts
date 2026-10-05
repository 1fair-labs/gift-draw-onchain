import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The one-click verifier: a static page built from this repository's own verification code and
 * published to GitHub Pages (`.github/workflows/pages.yml`). `npm run web:dev` serves it locally.
 */
export default defineConfig({
  root: here('.'),
  // Project pages live under the repository name.
  base: process.env.PAGES_BASE ?? '/gift-draw-onchain/',
  resolve: {
    alias: { crypto: here('./shims/crypto.ts') },
  },
  server: {
    // The page imports ../scripts, ../server and ../release.
    fs: { allow: [here('..')] },
    // Local development only: the live site answers the page's origin in production (github.io),
    // not localhost. Put this dev server's address in Settings → site to go through it.
    proxy: { '/api': { target: 'https://www.giftdraw.today', changeOrigin: true } },
  },
  build: {
    outDir: here('../dist'),
    emptyOutDir: true,
    // web3.js is most of the bundle; one file is fine for a single page.
    chunkSizeWarningLimit: 1500,
  },
});
