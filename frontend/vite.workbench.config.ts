import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// An independent entry: no AutoClip app bootstrap, API proxy, analytics or upload plugin.
export default defineConfig({
  plugins: [react()],
  base: './',
  envPrefix: 'WORKBENCH_',
  html: { cspNonce: 'd29ya2JlbmNoLWxvY2Fs' },
  optimizeDeps: { entries: ['workbench.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: 3100, strictPort: true },
  preview: { host: '127.0.0.1', port: 3100, strictPort: true },
  build: {
    outDir: 'dist-workbench',
    sourcemap: false,
    rollupOptions: { input: fileURLToPath(new URL('./workbench.html', import.meta.url)) },
  },
})
