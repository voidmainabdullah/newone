import { useCallback, useEffect, useRef, useState } from 'react'

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

type RecognitionCtor = new () => Recognition

function ctor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Voice input through the browser's own speech recognition. `supported` is false where the browser has none. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const rec = useRef<Recognition | null>(null)
  const cb = useRef(onText)
  cb.current = onText
  const [supported, setSupported] = useState(false)
  useEffect(() => setSupported(!!ctor()), [])
  useEffect(() => () => rec.current?.stop(), [])

  const toggle = useCallback(() => {
    if (rec.current) { rec.current.stop(); return }
    const C = ctor()
    if (!C) return
    const r = new C()
    r.lang = 'en-US'
    r.interimResults = false
    r.continuous = false
    r.onresult = (e) => {
      let t = ''
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript
      if (t.trim()) cb.current(t.trim())
    }
    r.onend = () => { rec.current = null; setListening(false) }
    r.onerror = () => { rec.current = null; setListening(false) }
    rec.current = r
    setListening(true)
    r.start()
  }, [])

  return { supported, listening, toggle }
}
