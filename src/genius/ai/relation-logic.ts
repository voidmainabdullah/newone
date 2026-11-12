/**
 * Deterministic repair of the data flow in a model-written blueprint. A relationship is stored on the CHILD and points at its
 * PARENT (Payment -> Booking -> Room -> Hostel). Models sometimes write it the wrong way round, repeat the link as a text
 * field, or close a loop. These checks run before validation, so the design is corrected instead of rejected, and every
 * correction is reported back as an assumption the user can read.
 */
type Any = Record<string, any>

/** Where a module normally sits in a business chain: lower = closer to the top (owner), higher = closer to the money. */
const RANKS: [RegExp, number][] = [
  [/\b(landlords?|owners?|compan(y|ies)|organi[sz]ations?|suppliers?|vendors?|franchis\w+)\b/i, 0],
  [/\b(hostels?|hotels?|propert(y|ies)|buildings?|branch(es)?|campus(es)?|schools?|clinics?|sites?|warehouses?|stores?)\b/i, 1],
  [/\b(rooms?|units?|apartments?|flats?|beds?|classes|class|classrooms?|departments?|wards?|courses?|products?|items?)\b/i, 2],
  [/\b(tenants?|residents?|students?|patients?|members?|customers?|clients?|guardians?|parents?|leads?|enquir(y|ies)|employees?|staff)\b/i, 2],
  [/\b(tenanc(y|ies)|leases?|bookings?|reservations?|enrol\w+|admissions?|appointments?|orders?|contracts?|agreements?|stays?|viewings?|visits?|subscriptions?)\b/i, 3],
  [/\b(payments?|invoices?|fees?|rents?|receipts?|charges?|transactions?|refunds?|deposits?|expenses?)\b/i, 4],
  [/\b(attendance|logs?|activit(y|ies)|notes?|follow-?ups?|tasks?|reminders?)\b/i, 4],
]

const rankOf = (m: Any): number | undefined => {
  const text = `${m?.plural ?? ''} ${m?.singular ?? ''} ${m?.id ?? ''}`.replace(/_/g, ' ')
  for (const [re, r] of RANKS) if (re.test(text)) return r
  return undefined
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/ies$/, 'y').replace(/s$/, '')

export function repairRelationships(bp: Any): string[] {
  const notes: string[] = []
  if (!Array.isArray(bp?.modules) || !Array.isArray(bp?.relationships)) return notes
  const mods = new Map<string, Any>((bp.modules as Any[]).filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m]))
  const rels = (bp.relationships as Any[]).filter((r) => r && mods.has(r.sourceModuleId) && mods.has(r.targetModuleId) && r.sourceModuleId !== r.targetModuleId)

  // 1. direction: the child stores the link to its parent
  for (const r of rels) {
    const s = mods.get(r.sourceModuleId)!
    const t = mods.get(r.targetModuleId)!
    const rs = rankOf(s)
    const rt = rankOf(t)
    const sideways = rs !== undefined && rt !== undefined && rs === rt
    const wrongByRank = rs !== undefined && rt !== undefined && rs < rt
    const wrongByKind = (t.kind === 'ledger' || t.kind === 'log') && s.kind !== 'ledger' && s.kind !== 'log'
    const oneToMany = r.cardinality === 'one-to-many'
    if (oneToMany || (!sideways && (wrongByRank || wrongByKind))) {
      const from = `${s.plural} -> ${t.plural}`
      r.sourceModuleId = t.id
      r.targetModuleId = s.id
      if (oneToMany) r.cardinality = 'many-to-one'
      r.label = s.singular ?? r.label
      const taken = new Set((mods.get(r.sourceModuleId)?.fields ?? []).map((f: Any) => f?.id))
      let id = `${norm(s.id)}_link`
      while (taken.has(id)) id += '_x'
      r.id = typeof r.id === 'string' && !taken.has(r.id) ? r.id : id
      notes.push(`The link ${from} pointed from parent to child, so it was turned around: ${t.plural} now store the link to their ${s.singular}.`)
    }
  }

  // 2. a loop can never be filled in: keep the first link, drop the one that closes it
  const edges: Any[] = []
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return edges.some((e) => e.sourceModuleId === from && reaches(e.targetModuleId, to, seen))
  }
  const kept: Any[] = []
  for (const r of rels) {
    if (kept.some((k) => k.sourceModuleId === r.sourceModuleId && k.targetModuleId === r.targetModuleId)) {
      notes.push(`A second link from ${mods.get(r.sourceModuleId)!.plural} to ${mods.get(r.targetModuleId)!.plural} was left out (it repeated the first).`)
      continue
    }
    if (reaches(r.targetModuleId, r.sourceModuleId)) {
      notes.push(`A link from ${mods.get(r.sourceModuleId)!.plural} to ${mods.get(r.targetModuleId)!.plural} was left out because it would make a loop.`)
      continue
    }
    edges.push(r)
    kept.push(r)
  }
  bp.relationships = (bp.relationships as Any[]).filter((r) => !rels.includes(r) || kept.includes(r))

  // 3. the relationship already is the link: no plain text field repeating the parent
  for (const r of kept) {
    const child = mods.get(r.sourceModuleId)!
    const parent = mods.get(r.targetModuleId)!
    const names = new Set([norm(parent.id), norm(parent.singular), norm(parent.plural)].flatMap((n) => [n, `${n}id`, `${n}name`, `${n}ref`, `${n}reference`]))
    const before = child.fields?.length ?? 0
    child.fields = (child.fields ?? []).filter((f: Any) => f?.id === r.id || !(['shortText', 'longText', 'number'].includes(f?.type) && (names.has(norm(f.id)) || names.has(norm(f.label)))))
    if (child.fields.length < before) notes.push(`${child.plural}: removed a text field that repeated the link to ${parent.plural}.`)
    if (child.displayFieldId && !child.fields.some((f: Any) => f.id === child.displayFieldId)) child.displayFieldId = child.fields.find((f: Any) => f.type === 'shortText')?.id
  }
  return notes
}
