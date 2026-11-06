import React, { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

/* Camera QR scanner — reads frames from the rear camera and decodes QR codes
   with jsQR (pure JS, works in the Capacitor webview with camera permission). */
export default function QrScanner({ onResult, onClose }) {
  const videoRef = useRef()
  const canvasRef = useRef()
  const rafRef = useRef()
  const streamRef = useRef()
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false

    async function start() {
      try {
        // request a high-res rear camera so the QR is sharp enough to decode
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const track = stream.getVideoTracks()[0]
        // enable continuous autofocus where the device supports it
        try {
          const caps = track.getCapabilities?.() || {}
          const advanced = []
          if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' })
          if (advanced.length) await track.applyConstraints({ advanced })
        } catch { /* focus control not supported — most cameras still autofocus */ }
        const v = videoRef.current
        v.srcObject = stream
        v.setAttribute('playsinline', 'true')
        v.setAttribute('autoplay', 'true')
        v.muted = true
        await v.play()
        tick()
      } catch (e) {
        setErr(
          e.name === 'NotAllowedError'
            ? 'Camera permission denied — allow it in settings, or enter details manually.'
            : "Can't open the camera — enter the details manually below."
        )
      }
    }

    let lastScan = 0
    function tick(ts) {
      const v = videoRef.current
      const c = canvasRef.current
      // decode ~7x/sec instead of every frame — keeps the preview smooth
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA && ts - lastScan > 140) {
        lastScan = ts
        c.width = v.videoWidth
        c.height = v.videoHeight
        const ctx = c.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(v, 0, 0, c.width, c.height)
        const img = ctx.getImageData(0, 0, c.width, c.height)
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })
        if (code?.data) {
          stop()
          onResult(code.data)
          return
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    function stop() {
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }

    start()
    return () => { cancelled = true; stop() }
  }, [onResult])

  return (
    <div className="qr-scan">
      <video ref={videoRef} className="qr-scan-video" />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <div className="qr-scan-frame" />
      <p className="qr-scan-hint">{err || 'Point at the QR code on your computer'}</p>
      <button className="qr-scan-close" onClick={onClose}>Cancel</button>
    </div>
  )
}
