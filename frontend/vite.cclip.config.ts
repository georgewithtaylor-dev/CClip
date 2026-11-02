import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const version = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).version

export default defineConfig({
  plugins: [react(), {
    name: 'cclip-local-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0].replaceAll('\\', '/').endsWith('/src/index.css')) {
        // CClip is offline by default. A blocked nested font import also rejects
        // Vite's CSS preload promise and prevents the deferred app from mounting.
        return code.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com\/[^'"\n]+['"]\);?\s*/g, '')
      }
    },
  }],
  base: './',
  define: {
    __CCLIP_BUILD__: true,
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
    'import.meta.env.VITE_PUBLIC_POSTHOG_KEY': '""',
    'import.meta.env.VITE_PUBLIC_SENTRY_DSN': '""',
  },
  build: {
    outDir: 'dist-cclip', sourcemap: false, chunkSizeWarningLimit: 1800,
    rollupOptions: { input: { cclip: `${root}cclip.html`, workbench: `${root}workbench.html` } },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 3103, strictPort: true, proxy: { '/api': { target: process.env.BACKEND_URL || 'http://127.0.0.1:13103', changeOrigin: true } } },
})
