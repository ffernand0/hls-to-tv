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

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) })
      if (resp.ok || resp.status === 404) return resp
    } catch (e) {
      if (i === retries - 1) throw e
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}

class HlsBuffer {
  constructor(sourceUrl, bufferMinutes = 1) { // Default 1 min
    this.sourceUrl = sourceUrl
    this.bufferSeconds = bufferMinutes * 60
    this.segments = []
    this.lastRequest = Date.now()
    this.isActive = false
    this.isFetching = false
    this.interval = null
    this.sequence = 0
    this.targetDuration = 4
  }

  async start() {
    if (this.isActive) return
    console.log(`[Buffer] Iniciando captura (Buffer: ${this.bufferSeconds}s)`)
    this.isActive = true
    this.tick()
    this.interval = setInterval(() => this.tick(), 4000)
  }

  stop() {
    console.log(`[Buffer] Deteniendo captura por inactividad prolongada.`)
    this.isActive = false
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.segments = []
  }

  async tick() {
    if (Date.now() - this.lastRequest > 300000) { // 5 min inactivity
      if (this.isActive) this.stop()
      return
    }
    if (this.isFetching) return
    this.isFetching = true

    try {
      let resp = await fetchWithRetry(this.sourceUrl, { headers: COMMON_HEADERS })
      if (!resp?.ok) return
      let text = await resp.text()

      if (text.includes('#EXT-X-STREAM-INF')) {
        const chunklistPath = text.split('\n').find(l => l.trim().endsWith('.m3u8') && !l.startsWith('#'))?.trim()
        if (chunklistPath) {
          resp = await fetchWithRetry(new URL(chunklistPath, this.sourceUrl).href, { headers: COMMON_HEADERS })
          if (resp?.ok) text = await resp.text()
        }
      }

      const lines = text.split('\n')
      let currentDuration = 4
      const newSegments = []

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.startsWith('#EXT-X-TARGETDURATION:')) this.targetDuration = parseInt(line.split(':')[1])
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:') && this.sequence === 0) this.sequence = parseInt(line.split(':')[1])
        if (line.startsWith('#EXTINF:')) {
          currentDuration = parseFloat(line.split(':')[1].split(',')[0])
          const segmentUrl = lines[i + 1]?.trim()
          if (!segmentUrl || segmentUrl.startsWith('#')) continue
          const filename = segmentUrl.split('?')[0].split('/').pop()
          if (!this.segments.find(s => s.filename === filename)) {
            newSegments.push({ filename, duration: currentDuration, url: new URL(segmentUrl, resp.url).href })
          }
        }
      }

      await Promise.allSettled(newSegments.map(async (seg) => {
        try {
          const sResp = await fetchWithRetry(seg.url, { headers: COMMON_HEADERS }, 2)
          if (sResp?.ok) {
            const data = await sResp.arrayBuffer()
            if (!this.isActive) return
            this.segments.push({ filename: seg.filename, duration: seg.duration, data: Buffer.from(data) })
          }
        } catch (e) { }
      }))

      this.segments.sort((a, b) => {
        // MATCH the last sequence of numbers in the filename
        const matchA = a.filename.match(/(\d+)\.[^.]+$/)
        const matchB = b.filename.match(/(\d+)\.[^.]+$/)
        const nA = matchA ? parseInt(matchA[1]) : 0
        const nB = matchB ? parseInt(matchB[1]) : 0
        return nA - nB
      })

      while (this.segments.length > 5 && this.segments.reduce((acc, s) => acc + s.duration, 0) > this.bufferSeconds) {
        this.segments.shift()
        this.sequence++
      }
    } catch (err) { 
      console.error('[Buffer] Tick error:', err.message)
    } finally {
      this.isFetching = false
    }
  }

  getManifest(hostUrl) {
    this.lastRequest = Date.now()
    const target = this.targetDuration || 4
    // Only show the last 10 segments to the player, even if we have more in memory
    const visibleSegments = this.segments.slice(-10)
    const seq = this.sequence + (this.segments.length - visibleSegments.length)

    let m3u = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:${seq}\n\n`
    visibleSegments.forEach(seg => {
      m3u += `#EXTINF:${seg.duration.toFixed(3)},\n${hostUrl}/stream/ahora/segment/${seg.filename}\n`
    })
    return m3u
  }
}

const ahoraBuffer = new HlsBuffer('https://stream.arcast.live/ahora/ahora/playlist.m3u8', 1)

const CHANNELS = {
  ahora: { name: 'Ahora Noticias', isBuffered: true },
  rts: {
    name: 'RTS Medios',
    resolve: async () => {
      const token = process.env.VITE_RTS_TOKEN || 'a8e0719241a74d64a7a31ce81740b490'
      const videoRes = await fetchWithRetry(`https://player-backend.restream.io/public/videos/${token}`, {
        headers: { ...COMMON_HEADERS, 'client-id': `hls-tv-${Math.random().toString(36).substring(2, 6)}`, 'player-version': '0.25.5' }
      })
      const data = await videoRes.json()
      return data.videoUrlHls
    }
  },
  telefe: {
    name: 'Telefe Santa Fe',
    resolve: async () => {
      const resp = await fetchWithRetry(`https://santafe.mitelefe.com/vidya/tokenize`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://telefecanal1.akamaized.net/hls/live/2033413-b/canal13santafe/TOK/master.m3u8' })
      })
      const data = await resp.json()
      return data.url
    }
  }
}

app.get('/playlist.m3u', (req, res) => {
  let m3u = '#EXTM3U\n'
  Object.keys(CHANNELS).forEach(id => {
    m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${CHANNELS[id].name}",${CHANNELS[id].name}\nhttp://${RASPBERRY_IP}:${PORT}/stream/${id}\n`
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
    res.redirect(302, await (channel.resolve ? channel.resolve() : channel.url))
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

app.listen(PORT, '0.0.0.0', () => console.log(`\n🚀 Server running on http://${RASPBERRY_IP}:${PORT}\n`))
