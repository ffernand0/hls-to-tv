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

// --- BUFFER LOGIC FOR "AHORA NOTICIAS" ---
class HlsBuffer {
  constructor(sourceUrl, bufferMinutes = 2) {
    this.sourceUrl = sourceUrl
    this.bufferSeconds = bufferMinutes * 60
    this.segments = [] // { filename, duration, data, url, timestamp }
    this.lastRequest = Date.now()
    this.isActive = false
    this.interval = null
    this.sequence = 0
  }

  async start() {
    if (this.isActive) return
    console.log(`[Buffer] Iniciando captura para Ahora Noticias...`)
    this.isActive = true
    this.tick()
    this.interval = setInterval(() => this.tick(), 4000)
  }

  stop() {
    console.log(`[Buffer] Deteniendo captura por inactividad.`)
    this.isActive = false
    clearInterval(this.interval)
    this.segments = [] // Clear memory
  }

  async tick() {
    // Si no hubo pedidos en 5 min, apagar
    if (Date.now() - this.lastRequest > 300000) {
      this.stop()
      return
    }

    try {
      let resp = await fetch(this.sourceUrl)
      if (!resp.ok) {
        console.error(`[Buffer] Error al bajar el origen: ${resp.status}`)
        return
      }
      let text = await resp.text()
      // console.log(`[Buffer] Origen descargado, largo: ${text.length}`)

      // Soporte para Master Playlists: Si detecta variantes, buscar el primer chunklist
      if (text.includes('#EXT-X-STREAM-INF')) {
        const lines = text.split('\n')
        const chunklistPath = lines.find(l => l.trim().endsWith('.m3u8') && !l.startsWith('#'))
        if (chunklistPath) {
          const baseUrl = this.sourceUrl.substring(0, this.sourceUrl.lastIndexOf('/') + 1)
          const newUrl = chunklistPath.trim().startsWith('http') ? chunklistPath.trim() : baseUrl + chunklistPath.trim()
          resp = await fetch(newUrl)
          if (!resp.ok) return
          text = await resp.text()
        }
      }
      
      const baseUrl = this.sourceUrl.substring(0, this.sourceUrl.lastIndexOf('/') + 1)
      const lines = text.split('\n')
      let duration = 0

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF:')) {
          duration = parseFloat(lines[i].split(':')[1])
          const segmentUrl = lines[i + 1]?.trim()
          if (!segmentUrl) continue
          
          const filename = segmentUrl.split('?')[0].split('/').pop()
          const fullUrl = segmentUrl.startsWith('http') ? segmentUrl : baseUrl + segmentUrl

          if (!this.segments.find(s => s.filename === filename)) {
            const segResp = await fetch(fullUrl)
            if (segResp.ok) {
              const buffer = await segResp.arrayBuffer()
              this.segments.push({
                filename,
                duration,
                data: Buffer.from(buffer),
                timestamp: Date.now()
              })
            }
          }
        }
      }

      // Cleanup: borrar lo que exceda el tiempo de buffer (pero dejar al menos 5 segmentos)
      const now = Date.now()
      while (this.segments.length > 5) {
        const totalBufferTime = this.segments.reduce((acc, s) => acc + s.duration, 0)
        if (totalBufferTime > this.bufferSeconds) {
          this.segments.shift()
          this.sequence++ // Incrementar secuencia para que el reproductor sepa que nos movimos
        } else {
          break
        }
      }
    } catch (err) {
      console.error(`[Buffer Error]`, err.message)
    }
  }

  getManifest(hostUrl) {
    this.lastRequest = Date.now()
    if (this.segments.length === 0) {
      console.log(`[Buffer] El manifiesto está vacío todavia (Segments: ${this.segments.length})`)
      return "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n"
    }

    let m3u = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n"
    m3u += `#EXT-X-MEDIA-SEQUENCE:${this.sequence}\n\n`

    this.segments.forEach(seg => {
      m3u += `#EXTINF:${seg.duration.toFixed(3)},\n`
      m3u += `${hostUrl}/stream/ahora/segment/${seg.filename}\n`
    })

    return m3u
  }
}

const ahoraBuffer = new HlsBuffer('https://stream.arcast.live/ahora/ahora/playlist.m3u8', 2)
// --- END BUFFER LOGIC ---

// Configuración de Canales
const CHANNELS = {
  ahora: {
    name: 'Ahora Noticias',
    isBuffered: true
  },
  rts: {
    name: 'RTS Medios',
    resolve: async () => {
      // Fallback si el .env no se sincronizó a la Pi
      const token = process.env.VITE_RTS_TOKEN || 'a8e0719241a74d64a7a31ce81740b490'
      const videoRes = await fetch(`https://player-backend.restream.io/public/videos/${token}`, {
        headers: {
          'client-id': `hls-tv-${Math.random().toString(36).substring(2, 6)}`,
          'player-version': '0.25.5',
          'Origin': 'https://player.restream.io',
          'Referer': 'https://player.restream.io/'
        }
      })
      if (!videoRes.ok) throw new Error(`RTS Token Fail (Status: ${videoRes.status})`)
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

// 2. Endpoint de Stream (Redirección dinámica o Buffer)
app.get('/stream/:id', async (req, res) => {
  const { id } = req.params
  const channel = CHANNELS[id]

  if (!channel) return res.status(404).send('Canal no encontrado')

  // Manejo especial para Ahora Noticias (Buffer)
  if (channel.isBuffered) {
    ahoraBuffer.lastRequest = Date.now()
    if (!ahoraBuffer.isActive) ahoraBuffer.start()
    
    const hostUrl = `http://${RASPBERRY_IP}:${PORT}`
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    return res.send(ahoraBuffer.getManifest(hostUrl))
  }

  try {
    let finalUrl = channel.url
    if (channel.resolve) {
      finalUrl = await channel.resolve()
    }

    res.redirect(302, finalUrl)
  } catch (err) {
    console.error(`Error resolviendo ${id}:`, err.message)
    res.status(500).send('Error al obtener el stream')
  }
})

// 3. Endpoint para segmentos del buffer
app.get('/stream/ahora/segment/:name', (req, res) => {
  const { name } = req.params
  const segment = ahoraBuffer.segments.find(s => s.filename === name)
  
  if (!segment) {
    return res.status(404).send('Segmento no disponible en buffer')
  }

  ahoraBuffer.lastRequest = Date.now()
  res.setHeader('Content-Type', 'video/MP2T')
  res.send(segment.data)
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
  console.log(`-----------------------------------`)
  console.log(`\x1b[32m💡 TIP: Para que inicie solo al prender la Pi:\x1b[0m`)
  console.log(`1. sudo npm install -g pm2`)
  console.log(`2. pm2 start server.js --name "hls-to-tv"`)
  console.log(`3. pm2 startup (y copiar el comando que te da)`)
  console.log(`4. pm2 save`)
  console.log(`-----------------------------------\n`)
})
