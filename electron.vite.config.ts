import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    server: { host: '127.0.0.1' },
    // Keep even small font subsets as local files, matching the strict font-src CSP.
    build: { assetsInlineLimit: 0 },
  },
})
