/** Soft interface sounds made with the Web Audio API (no files). Off when the user mutes them. */
const KEY = 'sortblink.sound'
let ctx: AudioContext | null = null

export const soundOn = () => {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}
export const setSound = (on: boolean) => {
  try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* private mode */ }
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  ctx ??= new AC()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function tone(freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'sine') {
  const c = audio()
  if (!c) return
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.value = freq
  const t = c.currentTime + start
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(c.destination)
  o.start(t)
  o.stop(t + dur + 0.02)
}

export const sound = {
  /** the message was sent */
  send() { if (soundOn()) { tone(520, 0, 0.12, 0.06); tone(780, 0.07, 0.14, 0.05) } },
  /** a step of the build started or finished */
  step() { if (soundOn()) tone(660, 0, 0.09, 0.035) },
  /** the AI asks something */
  ask() { if (soundOn()) { tone(600, 0, 0.12, 0.05); tone(450, 0.1, 0.16, 0.05) } },
  /** the design is ready */
  done() { if (soundOn()) { tone(523, 0, 0.16, 0.06); tone(659, 0.11, 0.16, 0.06); tone(784, 0.22, 0.3, 0.06) } },
  /** something failed */
  error() { if (soundOn()) { tone(300, 0, 0.18, 0.06, 'triangle'); tone(220, 0.14, 0.26, 0.06, 'triangle') } },
}
