import { useState, useEffect, useRef } from 'react'
import Hls from 'hls.js'
import { Tv, Play, Square, Cast } from 'lucide-react'
import './index.css'

const CHANNELS = [
  {
    id: 'ahora',
    name: 'Ahora Noticias',
    url: 'https://stream.arcast.live/ahora/ahora/playlist.m3u8'
  },
  {
    id: 'rts',
    name: 'RTS Medios',
    resolveUrl: async () => {
      const token = import.meta.env.VITE_RTS_TOKEN;
      // Utilizamos un proxy para evitar bloqueos por CORS o AdBlockers
      const baseUrl = '/api/restream';
      
      const videoRes = await fetch(`${baseUrl}/public/videos/${token}`, {
        headers: { 
          'client-id': Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15), 
          'player-version': '0.25.5' 
        }
      });
      
      if (!videoRes.ok) {
        throw new Error('No se pudo obtener el link de RTS');
      }
      
      const videoData = await videoRes.json();
      
      // Reescribimos la URL de Cloudflare para que también pase por el proxy y evite errores CORS de reproducción
      return videoData.videoUrlHls.replace('https://customer-gllhkkbamkskdl1p.cloudflarestream.com', '/api/cloudflare');
    }
  },
  {
    id: 'telefe-santafe',
    name: 'Telefe Santa Fe',
    resolveUrl: async () => {
      // Telefe Tokenize endpoint
      const baseUrl = '/api/mitelefe';
      const masterUrl = 'https://telefecanal1.akamaized.net/hls/live/2033413-b/canal13santafe/TOK/master.m3u8';
      
      const response = await fetch(`${baseUrl}/vidya/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: masterUrl })
      });
      
      if (!response.ok) {
        throw new Error('No se pudo tokenizar la transmisión de Telefe');
      }
      
      const data = await response.json();
      const signedUrl = data.url;
      
      if (signedUrl) {
        // Apply Telefe local proxy
        return signedUrl.replace('https://telefecanal1.akamaized.net', '/api/telefe-akamai');
      }
      throw new Error('No se recibió una URL válida de Telefe');
    }
  }
]

function App() {
  const [streamUrl, setStreamUrl] = useState('https://stream.arcast.live/ahora/ahora/playlist.m3u8')
  const [isPlaying, setIsPlaying] = useState(false)
  const [castConnected, setCastConnected] = useState(false)
  const videoRef = useRef(null)
  const hlsRef = useRef(null)

  // Initialize Cast SDK
  useEffect(() => {
    const initializeCastApi = () => {
      try {
        const castContext = cast.framework.CastContext.getInstance()
        castContext.setOptions({
          receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        })

        castContext.addEventListener(
          cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
          (event) => {
            switch (event.sessionState) {
              case cast.framework.SessionState.SESSION_STARTED:
              case cast.framework.SessionState.SESSION_RESUMED:
                setCastConnected(true)
                break
              case cast.framework.SessionState.SESSION_ENDED:
                setCastConnected(false)
                break
              default:
                break
            }
          }
        )
      } catch (err) {
        console.error("Cast initialization failed:", err);
      }
    }

    if (window.chrome && window.chrome.cast && window.chrome.cast.isAvailable) {
      initializeCastApi()
    } else {
      window.__onGCastApiAvailable = (isAvailable) => {
        if (isAvailable) {
          initializeCastApi()
        }
      }
    }
  }, [])

  // Handle local HLS playback
  useEffect(() => {
    if (!videoRef.current) return

    const actualStreamUrl = streamUrl ? streamUrl.toString() : '';

    if (isPlaying && actualStreamUrl) {
      if (Hls.isSupported()) {
        const hls = new Hls({ debug: false })
        hlsRef.current = hls
        hls.loadSource(actualStreamUrl)
        hls.attachMedia(videoRef.current)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoRef.current.play().catch(e => console.error("Auto-play prevented", e))
        })
      } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
        // For Safari support
        videoRef.current.src = actualStreamUrl
        videoRef.current.addEventListener('loadedmetadata', () => {
          videoRef.current.play().catch(e => console.error("Auto-play prevented", e))
        })
      }
    } else {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      videoRef.current.src = ''
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
      }
    }
  }, [streamUrl, isPlaying])

  const handlePlayLocally = () => {
    setIsPlaying(!isPlaying)
  }

  const handleCastMedia = async () => {
    const castSession = cast.framework.CastContext.getInstance().getCurrentSession()
    if (!castSession) {
      console.warn("No active cast session. Trying to request session...")
      try {
        await cast.framework.CastContext.getInstance().requestSession()
      } catch (e) {
        console.error("Error requesting cast session", e)
        return
      }
    }
    
    // Re-check after potential session request
    const activeSession = cast.framework.CastContext.getInstance().getCurrentSession()
    if (!activeSession) return

    const actualStreamUrl = streamUrl ? streamUrl.toString() : '';
    
    // Resolve any relative proxy URLs (like /api/cloudflare) to absolute URLs based on current host
    const absoluteStreamUrl = new URL(actualStreamUrl, window.location.href).href;

    // En producción/Nginx, el Chromecast DEBE recibir la URL absoluta de nuestro Proxy
    // para que la TV le pida el video a nuestro PC y así saltar el CORS.
    let castStreamUrl = absoluteStreamUrl;

    // Si el usuario usa localhost para testear y la URL del video pasa por nuestro proxy, 
    // el Chromecast fallará al intentar conectar con "127.0.0.1" (la TV no puede ver el PC localmente así).
    if ((window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') && actualStreamUrl.startsWith('/api/')) {
      alert("¡ATENCIÓN! El Chromecast no puede conectarse a '127.0.0.1'.\n\nPor favor, abre terminal, copia el servidor 'Network:' y ábrelo en lugar de localhost para que la TV pueda recibir el video.");
      return;
    }

    const mediaInfo = new chrome.cast.media.MediaInfo(castStreamUrl, 'application/x-mpegURL')
    mediaInfo.streamType = chrome.cast.media.StreamType.LIVE
    
    const metaData = new chrome.cast.media.GenericMediaMetadata()
    metaData.title = 'Live HLS Stream'
    mediaInfo.metadata = metaData

    const request = new chrome.cast.media.LoadRequest(mediaInfo)

    try {
      await activeSession.loadMedia(request)
      console.log('Media casted successfully')
      // Stop local playback if it was running
      if (isPlaying) {
        setIsPlaying(false)
      }
    } catch (e) {
      console.error('Error casting media', e)
    }
  }

  return (
    <div className="app-container">
      <header className="header">
        <h1><Tv size={32} color="var(--primary-color)" /> HLS Caster</h1>
        <div className="status-badge">
          <div className="status-indicator"></div>
          {castConnected ? 'Chromecast Connected' : 'Chromecast Disconnected'}
        </div>
      </header>

      <div className="video-container">
        {/* We use playsInline and muted if we want autoplay, but here we require user interaction anyway */}
        <video 
          ref={videoRef} 
          className="video-player" 
          controls 
          playsInline
          poster="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='450' fill='%23000'><rect width='100%25' height='100%25'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='24' fill='%23666'>Preview Area</text></svg>"
        />
      </div>

      <div className="controls-card">
        <div className="channels-section">
          <label>Canales Rápidos</label>
          <div className="channels-grid">
            {CHANNELS.map(channel => {
              const isActive = (channel.url && streamUrl === channel.url) || (!channel.url && channel.id === streamUrl.activeChannelId);
              return (
                <button
                  key={channel.id}
                  className={`channel-btn ${isActive ? 'active' : ''}`}
                  onClick={async () => {
                    if (channel.resolveUrl) {
                      try {
                        const dynamicUrl = await channel.resolveUrl();
                        const finalUrl = new String(dynamicUrl);
                        finalUrl.activeChannelId = channel.id;
                        setStreamUrl(finalUrl);
                      } catch (err) {
                        alert("Error cargando canal: " + err.message);
                      }
                    } else {
                      setStreamUrl(channel.url);
                    }
                  }}
                >
                  {channel.name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="input-group">
          <label htmlFor="stream-url">HLS Stream URL</label>
          <input
            id="stream-url"
            type="text"
            className="stream-input"
            value={streamUrl}
            onChange={(e) => setStreamUrl(e.target.value)}
            placeholder="https://example.com/playlist.m3u8"
          />
        </div>

        <div className="action-buttons">
          <button 
            className="btn btn-primary" 
            onClick={handlePlayLocally}
          >
            {isPlaying ? (
              <><Square size={20} /> Stop Local</>
            ) : (
              <><Play size={20} /> Play Local</>
            )}
          </button>
          
          <button 
            className="btn btn-cast" 
            onClick={handleCastMedia}
          >
            <Cast size={20} /> Cast to TV
          </button>
          
          <div className="cast-btn-wrapper">
            {/* The Google Cast button provided by cast_sender.js */}
            <google-cast-launcher></google-cast-launcher>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
