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
const RASPBERRY_IP = '192.168.1.35'

app.use(cors())
app.use(express.json())

// Common User Agent to avoid blocks
const COMMON_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }

// --- BUFFER LOGIC FOR "AHORA NOTICIAS" ---
class HlsBuffer {
  constructor(sourceUrl, bufferMinutes = 2) {
    this.sourceUrl = sourceUrl
    this.bufferSeconds = bufferMinutes * 60
    this.segments = [] // { filename, duration, data, timestamp }
    this.lastRequest = Date.now()
    this.isActive = false
    this.interval = null
    this.sequence = 0
    this.targetDuration = 10
  }

  async start() {
    if (this.isActive) return
    console.log(`[Buffer] Iniciando captura (Buffer: ${this.bufferSeconds / 60}min)`)
    this.isActive = true
    this.tick()
    this.interval = setInterval(() => this.tick(), 2000)
  }

  stop() {
    console.log(`[Buffer] Deteniendo captura por inactividad.`)
    this.isActive = false
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.segments = []
  }

  async tick() {
    // Timeout of 30 seconds of inactivity to stop the recorder
    if (Date.now() - this.lastRequest > 30000) {
      if (this.isActive) this.stop()
      return
    }

    try {
      let resp = await fetch(this.sourceUrl, { headers: COMMON_HEADERS })
      if (!resp.ok) {
        console.error(`[Buffer] Source error: ${resp.status}`)
        return
      }
      let text = await resp.text()

      // Handle Master Playlists
      if (text.includes('#EXT-X-STREAM-INF')) {
        const lines = text.split('\n')
        const chunklistPath = lines.find(l => l.trim().endsWith('.m3u8') && !l.startsWith('#'))?.trim()
        if (chunklistPath) {
          const newUrl = new URL(chunklistPath, this.sourceUrl).href
          resp = await fetch(newUrl, { headers: COMMON_HEADERS })
          if (!resp.ok) return
          text = await resp.text()
        }
      }

      const lines = text.split('\n')
      let currentDuration = 0
      const newSegmentsFound = []

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
          this.targetDuration = parseInt(line.split(':')[1])
        }
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          const sourceSeq = parseInt(line.split(':')[1])
          if (this.sequence === 0) this.sequence = sourceSeq
        }
        if (line.startsWith('#EXTINF:')) {
          currentDuration = parseFloat(line.split(':')[1].split(',')[0])
          const segmentUrl = lines[i + 1]?.trim()
          if (!segmentUrl || segmentUrl.startsWith('#')) continue

          const filename = segmentUrl.split('?')[0].split('/').pop()
          const fullUrl = new URL(segmentUrl, resp.url).href // Use absolute URL correctly

          if (!this.segments.find(s => s.filename === filename)) {
            newSegmentsFound.push({ filename, duration: currentDuration, url: fullUrl })
          }
        }
      }

      if (newSegmentsFound.length > 0) {
        // Parallel download with basic error handling
        await Promise.all(newSegmentsFound.map(async (seg) => {
          try {
            const segResp = await fetch(seg.url, { headers: COMMON_HEADERS })
            if (segResp.ok) {
              const buffer = await segResp.arrayBuffer()
              // Safety: check if stopped while downloading
              if (!this.isActive) return
              this.segments.push({
                filename: seg.filename,
                duration: seg.duration,
                data: Buffer.from(buffer),
                timestamp: Date.now()
              })
            }
          } catch (e) {
            console.error(`[Buffer] Segment fetch error (${seg.filename}):`, e.message)
          }
        }))

        this.segments.sort((a, b) => {
          const numA = parseInt(a.filename.match(/\d+/)?.[0] || 0)
          const numB = parseInt(b.filename.match(/\d+/)?.[0] || 0)
          return numA - numB
        })
      }

      // Buffer management: keep roughly 2 minutes
      while (this.segments.length > 5) {
        const totalBufferTime = this.segments.reduce((acc, s) => acc + s.duration, 0)
        if (totalBufferTime > this.bufferSeconds) {
          this.segments.shift()
          this.sequence++
        } else {
          break
        }
      }
    } catch (err) {
      console.error(`[Buffer Loop Error]`, err.message)
    }
  }

  getManifest(hostUrl) {
    this.lastRequest = Date.now()
    if (this.segments.length === 0) {
      return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${this.targetDuration}\n#EXT-X-MEDIA-SEQUENCE:0\n`
    }

    let m3u = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${this.targetDuration}\n`
    m3u += `#EXT-X-MEDIA-SEQUENCE:${this.sequence}\n\n`

    this.segments.forEach(seg => {
      m3u += `#EXTINF:${seg.duration.toFixed(3)},\n`
      m3u += `${hostUrl}/stream/ahora/segment/${seg.filename}\n`
    })

    return m3u
  }
}

// Global instance to prevent multiple pollers
const ahoraBuffer = new HlsBuffer('https://stream.arcast.live/ahora/ahora/playlist.m3u8', 2)

// --- CHANNELS CONFIG ---
const CHANNELS = {
  ahora: { name: 'Ahora Noticias', isBuffered: true },
  rts: {
    name: 'RTS Medios',
    resolve: async () => {
      const token = process.env.VITE_RTS_TOKEN || 'a8e0719241a74d64a7a31ce81740b490'
      console.log(`[RTS] Resolving ID: ${token}`)
      const videoRes = await fetch(`https://player-backend.restream.io/public/videos/${token}`, {
        headers: {
          'client-id': `hls-tv-${Math.random().toString(36).substring(2, 6)}`,
          'player-version': '0.25.5',
          'Origin': 'https://player.restream.io',
          'Referer': 'https://player.restream.io/'
        }
      })
      if (!videoRes.ok) throw new Error(`[RTS] Backend error: ${videoRes.status}`)
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
          ...COMMON_HEADERS,
          'Content-Type': 'application/json',
          'Referer': 'https://santafe.mitelefe.com/telefe-santa-fe-en-vivo',
          'Origin': 'https://santafe.mitelefe.com'
        },
        body: JSON.stringify({ url: masterUrl })
      })
      if (!response.ok) throw new Error(`[Telefe] Token error: ${response.status}`)
      const data = await response.json()
      return data.url
    }
  }
}

app.get('/playlist.m3u', (req, res) => {
  let m3u = '#EXTM3U\n'
  const baseUrl = `http://${RASPBERRY_IP}:${PORT}`
  Object.keys(CHANNELS).forEach(id => {
    m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${CHANNELS[id].name}",${CHANNELS[id].name}\n`
    m3u += `${baseUrl}/stream/${id}\n`
  })
  res.setHeader('Content-Type', 'audio/x-mpegurl')
  res.send(m3u)
})

app.get('/stream/:id', async (req, res) => {
  const { id } = req.params
  const channel = CHANNELS[id]
  if (!channel) return res.status(404).send('Not Found')

  if (channel.isBuffered) {
    if (!ahoraBuffer.isActive) ahoraBuffer.start()
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    return res.send(ahoraBuffer.getManifest(`http://${RASPBERRY_IP}:${PORT}`))
  }

  try {
    const finalUrl = await (channel.resolve ? channel.resolve() : channel.url)
    res.redirect(302, finalUrl)
  } catch (err) {
    console.error(`[Stream Error] ${id}:`, err.message)
    res.status(500).send(err.message)
  }
})

app.get('/stream/ahora/segment/:name', (req, res) => {
  const segment = ahoraBuffer.segments.find(s => s.filename === req.params.name)
  if (!segment) return res.status(404).send('Not in buffer')
  ahoraBuffer.lastRequest = Date.now()
  res.setHeader('Content-Type', 'video/MP2T')
  res.send(segment.data)
})

app.use(express.static(path.join(__dirname, 'dist')))
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running on http://${RASPBERRY_IP}:${PORT}`)
  console.log(`📜 M3U Playlist: http://${RASPBERRY_IP}:${PORT}/playlist.m3u\n`)
})
