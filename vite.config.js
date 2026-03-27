import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['vite.svg'],
      manifest: {
        name: 'HLS Caster',
        short_name: 'HLSCast',
        description: 'PWA to cast HLS streams to Chromecast',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          {
            src: '/vite.svg',
            sizes: 'any',
            type: 'image/svg+xml'
          }
        ]
      }
    })
  ],
  server: {
    host: '0.0.0.0',
    port: 8889,
    strictPort: false,
    proxy: {
      '/api/restream': {
        target: 'https://player-backend.restream.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/restream/, ''),
        headers: {
          'Origin': 'https://player.restream.io',
          'Referer': 'https://player.restream.io/'
        }
      },
      '/api/cloudflare': {
        target: 'https://customer-gllhkkbamkskdl1p.cloudflarestream.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/cloudflare/, '')
      },
      '/api/mitelefe': {
        target: 'https://santafe.mitelefe.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/mitelefe/, ''),
        headers: {
          'Origin': 'https://santafe.mitelefe.com',
          'Referer': 'https://santafe.mitelefe.com/telefe-santa-fe-en-vivo'
        }
      },
      '/api/telefe-akamai': {
        target: 'https://telefecanal1.akamaized.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/telefe-akamai/, ''),
        headers: {
          'Origin': 'https://santafe.mitelefe.com',
          'Referer': 'https://santafe.mitelefe.com/'
        }
      }
    }
  }
})
