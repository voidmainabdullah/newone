import { useEffect, useMemo, useRef, useState } from 'react'
import { useAllModules, useUsers, useWsId } from '#/hooks/useData'
import { useModuleStore } from '#/stores/moduleStore'
import { useRecordStore } from '#/stores/recordStore'
import { useUiStore } from '#/stores/uiStore'
import { currentActor } from '#/genius/service/builder'
import { runSearch, type QuerySpec, type SearchFilter, type SearchResult } from '#/genius/search/query'
import { planSearch, searchCatalog } from '#/genius/search/plan'
import { httpTransport } from '#/genius/service/transport'
import { Page } from '#/components/layout/Page'
import { Button } from '#/components/ui/Button'
import { Icon } from '#/components/ui/Icon'
import { Input, Select } from '#/components/ui/controls'
import { Badge, Card, EmptyState, Notice, PageHeader, Spinner } from '#/components/ui/misc'
import { toast } from '#/utils/toast'
import { cn } from '#/utils/id'

const PAGE = 15
const OPS: { id: SearchFilter['op']; label: string }[] = [
  { id: 'eq', label: 'is' },
  { id: 'neq', label: 'is not' },
  { id: 'contains', label: 'contains' },
  { id: 'gt', label: 'greater than' },
  { id: 'gte', label: 'at least' },
  { id: 'lt', label: 'less than' },
  { id: 'lte', label: 'at most' },
  { id: 'empty', label: 'is empty' },
  { id: 'not_empty', label: 'is not empty' },
]

interface Saved { name: string; spec: QuerySpec }
const storeKey = (ws: string) => `sortblink.search.${ws}`
const load = (ws: string): { recent: string[]; saved: Saved[] } => {
  try {
    return { recent: [], saved: [], ...(JSON.parse(localStorage.getItem(storeKey(ws)) ?? '{}') as object) }
  } catch {
    return { recent: [], saved: [] }
  }
}

/** Marks the searched words in an excerpt. Plain React nodes, never raw HTML. */
function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  const ts = tokens.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!ts.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${ts.join('|')})`, 'i'))
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-warning/25 px-0.5 text-fg">{p}</mark> : <span key={i}>{p}</span>))}</>
}

export function SearchPage() {
  const ws = useWsId()
  const modules = useAllModules()
  const users = useUsers()
  const records = useRecordStore((s) => s.records)
  const allModules = useModuleStore((s) => s.modules)
  const showRecord = useUiStore((s) => s.showRecord)

  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [chip, setChip] = useState<string | null>(null)
  const [filters, setFilters] = useState<SearchFilter[]>([])
  const [sort, setSort] = useState<'relevance' | 'newest' | 'oldest'>('relevance')
  const [page, setPage] = useState(0)
  const [planned, setPlanned] = useState<QuerySpec | null>(null)
  const [plannedInfo, setPlannedInfo] = useState<{ summary: string; assumptions: string[] } | null>(null)
  const [ask, setAsk] = useState('')
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [memory, setMemory] = useState(() => load(ws))
  const [fieldRef, setFieldRef] = useState('')
  const [op, setOp] = useState<SearchFilter['op']>('eq')
  const [value, setValue] = useState('')
  const [saveName, setSaveName] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => { setMemory(load(ws)) }, [ws])
  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setQ(text); setPage(0) }, 180)
    return () => clearTimeout(timer.current)
  }, [text])
  const persist = (next: { recent: string[]; saved: Saved[] }) => { setMemory(next); try { localStorage.setItem(storeKey(ws), JSON.stringify(next)) } catch { /* private mode */ } }

  const actor = currentActor()
  const env = useMemo(() => ({ workspaceId: ws, modules: allModules, records, users, actor }), [ws, allModules, records, users, actor.userId, actor.role?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // the spec: an AI-planned one wins; otherwise the box, chips and filters
  const base: QuerySpec = useMemo(() => planned ?? { text: q || undefined, filters: filters.length ? filters : undefined }, [planned, q, filters])
  const spec: QuerySpec = useMemo(() => ({ ...base, scope: chip ? [chip] : base.scope, sort: planned ? base.sort : undefined, limit: PAGE, offset: page * PAGE }), [base, chip, page, planned])
  const everywhere = useMemo(() => runSearch({ ...base, scope: base.scope, limit: 1 }, env), [base, env])
  const result: SearchResult = useMemo(() => {
    const r = runSearch(spec, env)
    if (!r.ok || planned || sort === 'relevance') return r
    return runSearch({ ...spec, sort: [{ field: '__createdAt', dir: sort === 'newest' ? 'desc' : 'asc' }] }, env)
  }, [spec, env, sort, planned])

  const fieldOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of modules) if (!m.system && (!chip || m.id === chip)) for (const f of m.fields) if (!seen.has(f.label.toLowerCase())) seen.set(f.label.toLowerCase(), f.label)
    return [...seen.values()].sort()
  }, [modules, chip])

  const addFilter = () => {
    if (!fieldRef) return
    const needsValue = op !== 'empty' && op !== 'not_empty'
    if (needsValue && value.trim() === '') return
    const num = Number(value)
    setFilters((f) => [...f, { field: fieldRef, op, value: needsValue ? (value.trim() !== '' && Number.isFinite(num) && ['gt', 'gte', 'lt', 'lte'].includes(op) ? num : value.trim()) : undefined }])
    setValue(''); setPage(0)
  }

  const runAsk = async () => {
    const request = ask.trim()
    if (!request || asking) return
    setAsking(true); setAskError(null)
    const plan = await planSearch(request, ws, searchCatalog(allModules, ws, actor), httpTransport)
    setAsking(false)
    if (!plan.ok) { setAskError(plan.message); return }
    const trial = runSearch(plan.spec, env)
    if (!trial.ok) { setAskError(`I could not run that search: ${trial.errors.join(' ')}`); return }
    setPlanned(plan.spec); setPlannedInfo({ summary: plan.summary, assumptions: plan.assumptions }); setChip(null); setPage(0)
    persist({ ...memory, recent: [request, ...memory.recent.filter((x) => x !== request)].slice(0, 8) })
  }
  const clearPlan = () => { setPlanned(null); setPlannedInfo(null); setAskError(null) }
  const save = () => {
    const name = saveName.trim() || (planned ? ask.trim().slice(0, 40) : text.trim().slice(0, 40)) || 'Saved search'
    persist({ ...memory, saved: [{ name, spec: { ...base, scope: chip ? [chip] : base.scope } }, ...memory.saved.filter((s) => s.name !== name)].slice(0, 12) })
    setSaveName(''); toast.success('Search saved', `“${name}” is in this workspace's saved searches.`)
  }
  const openSaved = (s: Saved) => { setPlanned(s.spec); setPlannedInfo(null); setChip(null); setPage(0) }

  const hasQuery = !!(planned || q.trim() || filters.length || chip)
  const total = result.total
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const shown = modules.filter((m) => everywhere.moduleCounts[m.id])

  return (
    <Page title="Search" wide>
      <PageHeader title="Search" icon="Search" description="Find any record in this workspace. Normal searching runs on your own data in your browser, instantly. Use “Ask in plain words” when you want Studio to set up filters for you." />

      <Card className="mb-4 space-y-3 p-4">
        <div className="relative">
          <Icon name="Search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <Input aria-label="Search records" className="pl-9" value={text} onChange={(e) => { setText(e.target.value); clearPlan() }} placeholder="Name, email, phone, reference, address, notes…" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Ask in plain words" className="min-w-[260px] flex-1" value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runAsk() }} placeholder="Ask in plain words, e.g. tenants from London with overdue payments over 500" disabled={asking} />
          <Button variant="primary" icon="Sparkles" onClick={() => void runAsk()} disabled={asking || !ask.trim()}>{asking ? 'Thinking…' : 'Ask Studio'}</Button>
        </div>
        {askError && <Notice tone="warning">{askError}</Notice>}
        {planned && (
          <div className="rounded-lg border border-line bg-subtle p-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">What I searched</span>
              {result.applied.map((a) => <Badge key={a}>{a}</Badge>)}
              <button type="button" className="ml-auto text-xs text-link hover:underline" onClick={clearPlan}>Clear</button>
            </div>
            {plannedInfo?.summary && <p className="mt-1 text-muted">{plannedInfo.summary}</p>}
            {!!plannedInfo?.assumptions.length && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{plannedInfo.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="space-y-2 p-3">
            <h2 className="text-sm font-semibold">Modules</h2>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => { setChip(null); setPage(0) }} className={cn('rounded-full border px-2.5 py-1 text-xs', !chip ? 'border-primary bg-subtle text-link' : 'border-line hover:bg-subtle')}>All ({everywhere.total})</button>
              {shown.map((m) => (
                <button key={m.id} type="button" onClick={() => { setChip(chip === m.id ? null : m.id); setPage(0) }} className={cn('flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs', chip === m.id ? 'border-primary bg-subtle text-link' : 'border-line hover:bg-subtle')}>
                  <Icon name={m.icon} size={12} />{m.name} ({everywhere.moduleCounts[m.id]})
                </button>
              ))}
            </div>
          </Card>

          {!planned && (
            <Card className="space-y-2 p-3">
              <h2 className="text-sm font-semibold">Filters</h2>
              <p className="text-xs text-muted">Exact conditions. Each one must be true.</p>
              {filters.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs">
                  <span className="flex-1 truncate">{f.field} {OPS.find((o) => o.id === f.op)?.label} {Array.isArray(f.value) ? f.value.join(', ') : f.value === undefined ? '' : String(f.value)}</span>
                  <button type="button" aria-label="Remove filter" onClick={() => { setFilters((x) => x.filter((_, j) => j !== i)); setPage(0) }}><Icon name="X" size={12} /></button>
                </div>
              ))}
              <Select aria-label="Field" value={fieldRef} onChange={(e) => setFieldRef(e.target.value)}>
                <option value="">Field…</option>
                {fieldOptions.map((f) => <option key={f} value={f}>{f}</option>)}
              </Select>
              <Select aria-label="Operator" value={op} onChange={(e) => setOp(e.target.value as SearchFilter['op'])}>{OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
              {op !== 'empty' && op !== 'not_empty' && <Input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addFilter() }} placeholder="Value" />}
              <Button size="xs" icon="Plus" onClick={addFilter} disabled={!fieldRef}>Add filter</Button>
              {result.errors.length > 0 && <p className="text-xs text-danger">{result.errors[0]}</p>}
            </Card>
          )}

          <Card className="space-y-2 p-3">
            <h2 className="text-sm font-semibold">Saved and recent</h2>
            {hasQuery && (
              <div className="flex gap-1.5">
                <Input aria-label="Name for this search" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name" />
                <Button size="xs" icon="Save" onClick={save}>Save</Button>
              </div>
            )}
            {memory.saved.map((s) => (
              <div key={s.name} className="flex items-center gap-1">
                <button type="button" className="flex-1 truncate rounded-lg px-2 py-1 text-left text-xs hover:bg-subtle" onClick={() => openSaved(s)}><Icon name="Bookmark" size={12} className="mr-1 inline text-link" />{s.name}</button>
                <button type="button" aria-label={`Delete saved search ${s.name}`} className="text-muted hover:text-danger" onClick={() => persist({ ...memory, saved: memory.saved.filter((x) => x.name !== s.name) })}><Icon name="X" size={12} /></button>
              </div>
            ))}
            {memory.recent.map((r) => <button key={r} type="button" className="block w-full truncate rounded-lg px-2 py-1 text-left text-xs text-muted hover:bg-subtle" onClick={() => { setAsk(r); setText('') }}><Icon name="History" size={12} className="mr-1 inline" />{r}</button>)}
            {!memory.saved.length && !memory.recent.length && <p className="text-xs text-muted">Searches you save or ask for appear here.</p>}
          </Card>
        </div>

        <div className="min-w-0 space-y-3">
          {result.aggregate && (
            <Card className="p-4">
              <div className="text-xs text-muted">{result.aggregate.op}{result.aggregate.field ? ` of ${result.aggregate.field}` : ''} (calculated from your records, not by the AI)</div>
              <div className="mt-1 flex flex-wrap gap-6">{result.aggregate.values.map((v) => <div key={v.module}><div className="text-2xl font-semibold tabular-nums">{v.value.toLocaleString()}</div><div className="text-xs text-muted">{v.module}</div></div>)}</div>
            </Card>
          )}
          <div className="flex items-center justify-between text-[13px] text-muted">
            <span>{hasQuery ? `${total} result${total === 1 ? '' : 's'}` : `${everywhere.total} records across ${shown.length} module${shown.length === 1 ? '' : 's'}`}</span>
            {!planned && (
              <label className="flex items-center gap-2">Sort
                <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="relevance">Best match</option><option value="newest">Newest</option><option value="oldest">Oldest</option></Select>
              </label>
            )}
          </div>

          {asking && <Card className="flex items-center gap-2 p-4 text-[13px]"><Spinner />Studio is setting up the filters…</Card>}
          {!asking && !result.ok && <Notice tone="danger">{result.errors.join(' ')}</Notice>}
          {!asking && result.ok && total === 0 && (
            <EmptyState icon="SearchX" title={hasQuery ? 'No records match' : 'Nothing to search yet'} description={hasQuery ? 'Try fewer words, remove a filter, or check the spelling. Searching looks inside names, emails, phone numbers, notes and linked records.' : 'Add some records to a module, then search them here.'} />
          )}
          {result.ok && result.hits.map((h) => {
            const mod = modules.find((m) => m.id === h.moduleId)
            return (
              <Card key={`${h.moduleId}${h.recordId}`} className="p-3" onClick={() => showRecord(h.moduleId, h.recordId)}>
                <div className="flex items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `color-mix(in srgb, ${mod?.color ?? '#8ab4f8'} 15%, transparent)`, color: mod?.color ?? '#8ab4f8' }}><Icon name={mod?.icon} size={16} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="truncate text-sm font-semibold"><Highlight text={h.title} tokens={result.tokens} /></span><Badge>{h.moduleName}</Badge></div>
                    {h.matched && <p className="mt-0.5 text-[12px] text-muted"><span className="font-medium">{h.matched.field}:</span> <Highlight text={h.matched.excerpt} tokens={result.tokens} /></p>}
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted">{h.fields.filter((f) => f.value !== h.title).slice(0, 4).map((f) => <span key={f.label}>{f.label}: <span className="text-fg">{f.value}</span></span>)}</div>
                  </div>
                </div>
              </Card>
            )
          })}
          {result.ok && total > PAGE && (
            <div className="flex items-center justify-center gap-3 pt-1">
              <Button size="xs" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
              <span className="text-xs text-muted">Page {page + 1} of {pages}</span>
              <Button size="xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </div>
      </div>
    </Page>
  )
}
