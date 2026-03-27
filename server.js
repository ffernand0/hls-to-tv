import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000
const RASPBERRY_IP = '192.168.1.35' // Tu IP de Raspberry Pi

app.use(cors())
app.use(express.json())

// Configuración de Canales
const CHANNELS = {
  ahora: {
    name: 'Ahora Noticias',
    url: 'https://stream.arcast.live/ahora/ahora/playlist.m3u8'
  },
  rts: {
    name: 'RTS Medios',
    resolve: async () => {
      const token = process.env.VITE_RTS_TOKEN
      const videoRes = await fetch(`https://player-backend.restream.io/public/videos/${token}`, {
        headers: {
          'client-id': Math.random().toString(36).substring(2, 15),
          'player-version': '0.25.5'
        }
      })
      if (!videoRes.ok) throw new Error('RTS Token Fail')
      const data = await videoRes.json()
      return data.videoUrlHls
    }
  },
  telefe: {
    name: 'Telefe Santa Fe',
    resolve: async () => {
      const masterUrl = 'https://telefecanal1.akamaized.net/hls/live/2033413-b/canal13santafe/TOK/master.m3u8'
      const response = await fetch(`https://santafe.mitelefe.com/vidya/tokenize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Referer': 'https://santafe.mitelefe.com/telefe-santa-fe-en-vivo',
          'Origin': 'https://santafe.mitelefe.com'
        },
        body: JSON.stringify({ url: masterUrl })
      })
      if (!response.ok) throw new Error('Telefe Token Fail')
      const data = await response.json()
      return data.url
    }
  }
}

// 1. Generar Lista M3U para Android TV
app.get('/playlist.m3u', (req, res) => {
  let m3u = '#EXTM3U\n'
  const baseUrl = `http://${RASPBERRY_IP}:${PORT}`

  Object.keys(CHANNELS).forEach(id => {
    const ch = CHANNELS[id]
    m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${ch.name}",${ch.name}\n`
    m3u += `${baseUrl}/stream/${id}\n`
  })

  res.setHeader('Content-Type', 'audio/x-mpegurl')
  res.send(m3u)
})

// 2. Endpoint de Stream (Redirección dinámica)
app.get('/stream/:id', async (req, res) => {
  const { id } = req.params
  const channel = CHANNELS[id]

  if (!channel) return res.status(404).send('Canal no encontrado')

  try {
    let finalUrl = channel.url
    if (channel.resolve) {
      finalUrl = await channel.resolve()
    }

    // Redirigir al reproductor directamente a la URL final tokenizada
    // TiviMate y otros reproductores siguen redirecciones 302 sin problema.
    res.redirect(302, finalUrl)
  } catch (err) {
    console.error(`Error resolviendo ${id}:`, err.message)
    res.status(500).send('Error al obtener el stream')
  }
})

// Servir la PWA estática (si está buildeada en /dist)
app.use(express.static(path.join(__dirname, 'dist')))

// Manejo de SPA para la PWA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor levantado con éxito!`)
  console.log(`-----------------------------------`)
  console.log(`IP Local: http://localhost:${PORT}`)
  console.log(`IP Red: http://${RASPBERRY_IP}:${PORT}`)
  console.log(`\n📜 Lista M3U para Android TV:`)
  console.log(`👉 http://${RASPBERRY_IP}:${PORT}/playlist.m3u`)
  console.log(`-----------------------------------\n`)
})
