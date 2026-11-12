/** '12 sec' up to '59 sec', then '1 min 00 sec', '1 min 25 sec', '3 min 10 sec'. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} sec`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m} min ${String(s).padStart(2, '0')} sec`
}
