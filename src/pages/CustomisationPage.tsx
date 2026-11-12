import { useRef } from 'react'
import { useSettingsStore } from '#/stores/settingsStore'
import { usePerms } from '#/hooks/useData'
import { toast, confirmDialog } from '#/utils/toast'
import { Page } from '#/components/layout/Page'
import { Button } from '#/components/ui/Button'
import { Card, Notice, PageHeader, Segmented } from '#/components/ui/misc'
import { Field, Input } from '#/components/ui/controls'
import { useTheme, type ThemePref } from '#/stores/themeStore'

/** Downscale an uploaded image to a small data URL so it fits comfortably in localStorage. */
async function toSmallDataUrl(file: File, max = 160): Promise<string> {
  const bitmapUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read that image')); i.src = bitmapUrl })
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(img.width * scale))
    c.height = Math.max(1, Math.round(img.height * scale))
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9)
  } finally {
    URL.revokeObjectURL(bitmapUrl)
  }
}

export function CustomisationPage() {
  const brand = useSettingsStore((s) => s.settings.brand)
  const themePref = useTheme((s) => s.pref)
  const setThemePref = useTheme((s) => s.setPref)
  const setBrand = useSettingsStore((s) => s.setBrand)
  const perms = usePerms()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const can = perms.can('accessSettings')

  const upload = async (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') return toast.error('Choose a PNG, JPG, WebP or GIF image')
    if (f.size > 4 * 1024 * 1024) return toast.error('Image is too large', 'Use a file under 4 MB.')
    try { setBrand({ logo: await toSmallDataUrl(f) }); toast.success('Logo updated') } catch (e) { toast.error(e instanceof Error ? e.message : 'Upload failed') }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <Page title="Customisation" skeleton="form">
      <PageHeader title="Customisation" icon="Palette" description="Make Blitcrm yours. Changes apply instantly and are saved in this browser."
        actions={can && <Button icon="RotateCcw" onClick={async () => { if (await confirmDialog({ title: 'Reset branding to defaults?', confirmLabel: 'Reset' })) { useSettingsStore.getState().resetBrand(); toast.success('Branding reset') } }}>Reset to defaults</Button>} />
      {!can && <div className="mb-4"><Notice>Your role can’t change branding. You can still switch between the light and dark theme.</Notice></div>}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card className="space-y-4 p-5">
            <h3 className="text-sm font-semibold">Brand</h3>
            <Field label="Brand name"><Input value={brand.brandName} disabled={!can} maxLength={32} onChange={(e) => setBrand({ brandName: e.target.value })} onBlur={() => { if (!brand.brandName.trim()) setBrand({ brandName: 'Blitcrm' }) }} /></Field>
            <Field label="Logo" hint="Resized to fit; stored locally. Shown in the sidebar.">
              <div className="flex items-center gap-3">
                {brand.logo ? <img src={brand.logo} alt="Current logo" className="size-12 rounded-xl border border-line object-contain" /> : <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-white">{brand.brandName.slice(0, 1).toUpperCase()}</span>}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label="Upload logo" onChange={(e) => void upload(e.target.files?.[0])} />
                <Button disabled={!can} icon="Upload" onClick={() => fileRef.current?.click()}>Upload logo</Button>
                {brand.logo && <Button variant="ghost" disabled={!can} onClick={() => { setBrand({ logo: undefined }); toast.success('Logo removed') }}>Remove</Button>}
              </div>
            </Field>
          </Card>
          <Card className="space-y-4 p-5">
            <h3 className="text-sm font-semibold">Appearance</h3>
            <Field label="Theme" hint="Dark is the default. System follows your device. Saved in this browser."><Segmented<ThemePref> value={themePref} onChange={setThemePref} options={[{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'System' }]} /></Field>
            <Field label="Density" hint="Compact fits more rows on screen"><Segmented<'comfortable' | 'compact'> value={brand.density} onChange={(v) => setBrand({ density: v })} options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]} /></Field>
            <Field label={`Default form corner radius: ${brand.formRadius}px`}><input aria-label="Form corner radius" type="range" min={0} max={28} disabled={!can} value={brand.formRadius} onChange={(e) => setBrand({ formRadius: Number(e.target.value) })} className="w-full accent-[var(--color-primary)]" /></Field>
          </Card>
        </div>
        <Card className="h-fit space-y-3 p-5 lg:sticky lg:top-2">
          <h3 className="text-sm font-semibold">Preview</h3>
          <div className="flex items-center gap-2.5">{brand.logo ? <img src={brand.logo} alt="" className="size-8 rounded-lg object-contain" /> : <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-white">{brand.brandName.slice(0, 1).toUpperCase()}</span>}<span className="text-[15px] font-medium">{brand.brandName}</span></div>
          <div className="flex flex-wrap gap-2"><Button variant="primary">Primary</Button><Button>Secondary</Button><Button variant="soft">Soft</Button></div>
        </Card>
      </div>
    </Page>
  )
}
