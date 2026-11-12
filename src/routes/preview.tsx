import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AppPreview, OVERVIEW } from '#/components/studio/AppPreview'
import type { PApp } from '#/components/studio/previewModel'
import { PREVIEW_KEY } from '#/components/studio/previewModel'

export const Route = createFileRoute('/preview')({
  head: () => ({ meta: [{ title: 'Preview · Blitcrm' }] }),
  component: StandalonePreview,
})

/** The latest Studio preview in its own tab. No sign-in and no workspace: it only reads what Studio stashed in this browser. */
function StandalonePreview() {
  const [app, setApp] = useState<PApp | null | undefined>(undefined)
  const [page, setPage] = useState(OVERVIEW)
  const [w, setW] = useState(1200)
  useEffect(() => {
    try {
      setApp(JSON.parse(localStorage.getItem(PREVIEW_KEY) ?? 'null') as PApp | null)
    } catch {
      setApp(null)
    }
    const on = () => setW(window.innerWidth)
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  if (app === undefined) return <div className="h-screen bg-app" />
  if (!app) return <div className="flex h-screen items-center justify-center bg-app text-[13px] text-muted">Nothing to preview yet. Build a CRM in Blitcrm Studio first.</div>
  return (
    <div className="h-screen bg-app">
      <AppPreview app={app} page={page} onPage={setPage} device={w < 560 ? 'mobile' : w < 820 ? 'tablet' : 'desktop'} />
    </div>
  )
}
