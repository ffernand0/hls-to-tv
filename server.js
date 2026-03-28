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

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
}

// Utility to fetch with retry
async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) })
      if (resp.ok) return resp
      if (resp.status === 404) return resp // Don't retry on 404
      console.warn(`[Retry] URL ${url} returned ${resp.status}. Attempt ${i + 1}/${retries}`)
    } catch (e) {
      if (i === retries - 1) throw e
      const delay = Math.pow(2, i) * 1000
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

// --- BUFFER LOGIC ---
class HlsBuffer {
  constructor(sourceUrl, bufferMinutes = 2) {
    this.sourceUrl = sourceUrl
    this.bufferSeconds = bufferMinutes * 60
    this.segments = []
    this.lastRequest = Date.now()
    this.isActive = false
    this.interval = null
    this.sequence = 0
    this.targetDuration = 4
  }

  async start() {
    if (this.isActive) return
    console.log(`[Buffer] Iniciando captura robusta (Buffer: ${this.bufferSeconds / 60}min)`)
    this.isActive = true
    this.tick()
    // Aumentamos a 5 segundos para evitar bloqueos del servidor fuente
    this.interval = setInterval(() => this.tick(), 5000)
  }

  stop() {
    console.log(`[Buffer] Deteniendo captura por inactividad.`)
    this.isActive = false
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.segments = []
  }

  async tick() {
    if (Date.now() - this.lastRequest > 60000) { // 60s inactivity
      if (this.isActive) this.stop()
      return
    }

    try {
      let resp = await fetchWithRetry(this.sourceUrl, { headers: COMMON_HEADERS })
      if (!resp.ok) return
      let text = await resp.text()

      if (text.includes('#EXT-X-STREAM-INF')) {
        const lines = text.split('\n')
        const chunklistPath = lines.find(l => l.trim().endsWith('.m3u8') && !l.startsWith('#'))?.trim()
        if (chunklistPath) {
          const newUrl = new URL(chunklistPath, this.sourceUrl).href
          resp = await fetchWithRetry(newUrl, { headers: COMMON_HEADERS })
          if (!resp.ok) return
          text = await resp.text()
        }
      }

      const lines = text.split('\n')
      let currentDuration = 4
      const newSegmentsFound = []

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.startsWith('#EXT-X-TARGETDURATION:')) this.targetDuration = parseInt(line.split(':')[1])
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          const sourceSeq = parseInt(line.split(':')[1])
          if (this.sequence === 0) this.sequence = sourceSeq
        }
        if (line.startsWith('#EXTINF:')) {
          currentDuration = parseFloat(line.split(':')[1].split(',')[0])
          const segmentUrl = lines[i + 1]?.trim()
          if (!segmentUrl || segmentUrl.startsWith('#')) continue

          const filename = segmentUrl.split('?')[0].split('/').pop()
          const fullUrl = new URL(segmentUrl, resp.url).href

          if (!this.segments.find(s => s.filename === filename)) {
            newSegmentsFound.push({ filename, duration: currentDuration, url: fullUrl })
          }
        }
      }

      if (newSegmentsFound.length > 0) {
        // Download limit: Max 3 at a time to reduce load
        for (const seg of newSegmentsFound) {
          try {
            const segResp = await fetchWithRetry(seg.url, { headers: COMMON_HEADERS }, 2)
            if (segResp && segResp.ok) {
              const buffer = await segResp.arrayBuffer()
              if (!this.isActive) return
              this.segments.push({
                filename: seg.filename,
                duration: seg.duration,
                data: Buffer.from(buffer),
                timestamp: Date.now()
              })
            }
          } catch (e) {
            // Silently skip failed segments to avoid log spam, the buffer will handle the gap
          }
        }

        this.segments.sort((a, b) => {
          const numA = parseInt(a.filename.match(/\d+/)?.[0] || 0)
          const numB = parseInt(b.filename.match(/\d+/)?.[0] || 0)
          return numA - numB
        })
      }

      while (this.segments.length > 5 && this.segments.reduce((acc, s) => acc + s.duration, 0) > this.bufferSeconds) {
        this.segments.shift()
        this.sequence++
      }
    } catch (err) {
      // Basic catch for loop
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

const ahoraBuffer = new HlsBuffer('https://stream.arcast.live/ahora/ahora/playlist.m3u8', 2)

// --- CHANNELS ---
const CHANNELS = {
  ahora: { name: 'Ahora Noticias', isBuffered: true },
  rts: {
    name: 'RTS Medios',
    resolve: async () => {
      const token = process.env.VITE_RTS_TOKEN || 'a8e0719241a74d64a7a31ce81740b490'
      const videoRes = await fetchWithRetry(`https://player-backend.restream.io/public/videos/${token}`, {
        headers: {
          ...COMMON_HEADERS,
          'client-id': `hls-tv-${Math.random().toString(36).substring(2, 6)}`,
          'player-version': '0.25.5'
        }
      })
      if (!videoRes.ok) throw new Error(`RTS Backend Status: ${videoRes.status}`)
      const data = await videoRes.json()
      return data.videoUrlHls
    }
  },
  telefe: {
    name: 'Telefe Santa Fe',
    resolve: async () => {
      const masterUrl = 'https://telefecanal1.akamaized.net/hls/live/2033413-b/canal13santafe/TOK/master.m3u8'
      const response = await fetchWithRetry(`https://santafe.mitelefe.com/vidya/tokenize`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: masterUrl })
      })
      if (!response.ok) throw new Error(`Telefe Status: ${response.status}`)
      const data = await response.json()
      return data.url
    }
  }
}

app.get('/playlist.m3u', (req, res) => {
  let m3u = '#EXTM3U\n'
  Object.keys(CHANNELS).forEach(id => {
    m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${CHANNELS[id].name}",${CHANNELS[id].name}\n`
    m3u += `http://${RASPBERRY_IP}:${PORT}/stream/${id}\n`
  })
  res.setHeader('Content-Type', 'audio/x-mpegurl').send(m3u)
})

app.get('/stream/:id', async (req, res) => {
  const channel = CHANNELS[req.params.id]
  if (!channel) return res.status(404).send('Not Found')
  if (channel.isBuffered) {
    if (!ahoraBuffer.isActive) ahoraBuffer.start()
    return res.setHeader('Content-Type', 'application/vnd.apple.mpegurl').send(ahoraBuffer.getManifest(`http://${RASPBERRY_IP}:${PORT}`))
  }
  try {
    const finalUrl = await (channel.resolve ? channel.resolve() : channel.url)
    res.redirect(302, finalUrl)
  } catch (err) {
    res.status(500).send(err.message)
  }
})

app.get('/stream/ahora/segment/:name', (req, res) => {
  const segment = ahoraBuffer.segments.find(s => s.filename === req.params.name)
  if (!segment) return res.status(404).send('Retry')
  ahoraBuffer.lastRequest = Date.now()
  res.setHeader('Content-Type', 'video/MP2T').send(segment.data)
})

app.use(express.static(path.join(__dirname, 'dist')))
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running on http://${RASPBERRY_IP}:${PORT}\n`)
})
