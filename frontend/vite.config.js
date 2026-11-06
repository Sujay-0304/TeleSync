import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

const TOKEN_FILE = path.resolve(__dirname, '../backend/data/api_token.txt')

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        // dev convenience: the proxy signs browser requests with the API token
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            try {
              const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
              if (t && !proxyReq.getHeader('authorization')) {
                proxyReq.setHeader('Authorization', `Bearer ${t}`)
              }
            } catch { /* backend not started yet */ }
          })
        },
      },
    },
  },
})
