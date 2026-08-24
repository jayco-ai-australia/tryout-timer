'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { parseCsv } from '@/lib/csv'
import { fmtDate } from '@/lib/format'
import type {
  ChangeRequestStatus, Operator, OperatorChangeRequest,
  Product, ProductionLine, Team,
} from '@/lib/types'

type ConfigTab = 'lines' | 'teams' | 'operators' | 'products' | 'requests'

interface Props { userId: string }

const EMPTY: React.CSSProperties = { textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '28px 0' }
const ERR_BOX: React.CSSProperties = { marginTop: 10, padding: '9px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid #fecaca', color: 'var(--red)', fontSize: 13 }
const OK_BOX: React.CSSProperties = { marginTop: 10, padding: '9px 14px', borderRadius: 8, background: 'var(--green-bg)', border: '1px solid #86efac', color: '#15803d', fontSize: 13 }

async function readCsvFile(file: File): Promise<Record<string, string>[]> {
  const text = await file.text()
  return parseCsv(text)
}

export default function ConfigClient({ userId }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [tab, setTab] = useState<ConfigTab>('lines')
  const [productionLines, setProductionLines] = useState<ProductionLine[]>([])

  useEffect(() => {
    supabase.from('production_lines').select('*').order('name').then(({ data }) => setProductionLines(data ?? []))
  }, [supabase])

  const TABS: { key: ConfigTab; label: string }[] = [
    { key: 'lines', label: 'Production Lines' },
    { key: 'teams', label: 'Teams' },
    { key: 'operators', label: 'Operators' },
    { key: 'products', label: 'Products' },
    { key: 'requests', label: 'Change Requests' },
  ]

  return (
    <main className="page">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Config</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Master data: production lines, teams, operators, and products. Jobs and operations are managed in Setup.</p>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={tab === t.key ? 'tab tab-active' : 'tab'}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'lines' && <LinesTab supabase={supabase} lines={productionLines} setLines={setProductionLines} />}
      {tab === 'teams' && <TeamsTab supabase={supabase} lines={productionLines} />}
      {tab === 'operators' && <OperatorsTab supabase={supabase} lines={productionLines} />}
      {tab === 'products' && <ProductsTab supabase={supabase} lines={productionLines} />}
      {tab === 'requests' && <RequestsTab supabase={supabase} userId={userId} />}
    </main>
  )
}

// ── Tab 1: Production Lines ────────────────────────────────────────────
function LinesTab({ supabase, lines, setLines }: { supabase: ReturnType<typeof createClient>; lines: ProductionLine[]; setLines: (fn: (prev: ProductionLine[]) => ProductionLine[]) => void }) {
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setAdding(true); setError(null)
    const { data, error: err } = await supabase.from('production_lines').insert({ name: name.trim() }).select('*').single()
    if (err) setError(err.message)
    else if (data) { setLines((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name))); setName('') }
    setAdding(false)
  }

  return (
    <div>
      <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
        <table className="data-table"><thead><tr><th>Name</th></tr></thead>
          <tbody>{lines.map((l) => <tr key={l.id}><td className="primary">{l.name}</td></tr>)}</tbody>
        </table>
        {lines.length === 0 && <p style={EMPTY}>No production lines</p>}
      </div>
      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, maxWidth: 320 }}>
          <label className="label">New Production Line</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Caravan" required />
        </div>
        <button type="submit" disabled={adding || !name.trim()} className="btn-primary">{adding ? 'Adding…' : 'Add Line'}</button>
        {error && <p style={{ ...ERR_BOX, width: '100%' }}>{error}</p>}
      </form>
    </div>
  )
}

// ── Tab 2: Teams ────────────────────────────────────────────────────────
function TeamsTab({ supabase, lines }: { supabase: ReturnType<typeof createClient>; lines: ProductionLine[] }) {
  const [lineId, setLineId] = useState('')
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [hours, setHours] = useState('7.5')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!lineId) { setTeams([]); return }
    setLoading(true)
    supabase.from('teams').select('*').eq('production_line_id', lineId).order('name').then(({ data }) => { setTeams(data ?? []); setLoading(false) })
  }, [supabase, lineId])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !lineId) return
    setAdding(true); setError(null)
    const { data, error: err } = await supabase.from('teams').insert({ name: name.trim(), production_line_id: lineId, available_hours_per_day: Number(hours) || 7.5 }).select('*').single()
    if (err) setError(err.message)
    else if (data) { setTeams((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name))); setName(''); setHours('7.5') }
    setAdding(false)
  }

  return (
    <div>
      <div style={{ marginBottom: 20, maxWidth: 320 }}>
        <label className="label">Production Line</label>
        <select className="select" style={{ width: '100%' }} value={lineId} onChange={(e) => setLineId(e.target.value)}>
          <option value="">— Select a production line —</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {lineId && (
        <>
          <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
            {loading ? <p style={EMPTY}>Loading…</p> : (
              <table className="data-table">
                <thead><tr><th>Team</th><th className="right">Available hrs/day</th></tr></thead>
                <tbody>{teams.map((t) => <tr key={t.id}><td className="primary">{t.name}</td><td className="right">{t.available_hours_per_day}</td></tr>)}</tbody>
              </table>
            )}
            {!loading && teams.length === 0 && <p style={EMPTY}>No teams for this line</p>}
          </div>

          <form onSubmit={handleAdd} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200, maxWidth: 280 }}>
              <label className="label">New Team</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Body Electrical" required />
            </div>
            <div style={{ width: 140 }}>
              <label className="label">Hours / day</label>
              <input type="number" step="0.5" className="input" value={hours} onChange={(e) => setHours(e.target.value)} />
            </div>
            <button type="submit" disabled={adding || !name.trim()} className="btn-primary">{adding ? 'Adding…' : 'Add Team'}</button>
            {error && <p style={{ ...ERR_BOX, width: '100%' }}>{error}</p>}
          </form>
        </>
      )}
    </div>
  )
}

// ── Tab 3: Operators ────────────────────────────────────────────────────
function OperatorsTab({ supabase, lines }: { supabase: ReturnType<typeof createClient>; lines: ProductionLine[] }) {
  const [lineId, setLineId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [teams, setTeams] = useState<Team[]>([])
  const [operators, setOperators] = useState<Operator[]>([])
  const [loading, setLoading] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [fullName, setFullName] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [formTeamId, setFormTeamId] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importErr, setImportErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTeamId(''); setTeams([])
    if (!lineId) { setOperators([]); return }
    supabase.from('teams').select('*').eq('production_line_id', lineId).order('name').then(({ data }) => setTeams(data ?? []))
  }, [supabase, lineId])

  useEffect(() => {
    if (!lineId) { setOperators([]); return }
    setLoading(true)
    let q = supabase.from('operators').select('*, teams ( id, name )').eq('production_line_id', lineId).order('full_name')
    if (teamId) q = q.eq('team_id', teamId)
    q.then(({ data }) => { setOperators(data ?? []); setLoading(false) })
  }, [supabase, lineId, teamId])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!fullName.trim() || !lineId) return
    setAdding(true); setError(null)
    const { data, error: err } = await supabase.from('operators').insert({
      full_name: fullName.trim(), employee_id: employeeId.trim() || null, team_id: formTeamId || null, production_line_id: lineId,
    }).select('*, teams ( id, name )').single()
    if (err) setError(err.message)
    else if (data) {
      if (!teamId || teamId === formTeamId) setOperators((prev) => [...prev, data].sort((a, b) => a.full_name.localeCompare(b.full_name)))
      setShowAdd(false); setFullName(''); setEmployeeId(''); setFormTeamId('')
    }
    setAdding(false)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true); setImportMsg(null); setImportErr(null)
    try {
      const rows = await readCsvFile(file)
      const { data: allTeams } = await supabase.from('teams').select('id, name, production_line_id')
      let skipped = 0
      const withId: { full_name: string; employee_id: string; team_id: string | null; production_line_id: string | null }[] = []
      const withoutId: { full_name: string; team_id: string | null; production_line_id: string | null }[] = []
      for (const r of rows) {
        if (!r.full_name?.trim()) { skipped++; continue }
        const line = lines.find((l) => l.name.toLowerCase() === (r.production_line_name ?? '').toLowerCase())
        const team = (allTeams ?? []).find((t) => t.name.toLowerCase() === (r.team_name ?? '').toLowerCase() && (!line || t.production_line_id === line.id))
        const payload = { full_name: r.full_name.trim(), team_id: team?.id ?? null, production_line_id: line?.id ?? team?.production_line_id ?? null }
        if (r.employee_id?.trim()) withId.push({ ...payload, employee_id: r.employee_id.trim() })
        else withoutId.push(payload)
      }
      if (withId.length > 0) {
        const { error: err } = await supabase.from('operators').upsert(withId, { onConflict: 'employee_id' })
        if (err) throw err
      }
      if (withoutId.length > 0) {
        const { error: err } = await supabase.from('operators').insert(withoutId)
        if (err) throw err
      }
      setImportMsg(`Processed ${withId.length + withoutId.length}, skipped ${skipped}`)
      if (lineId) {
        let q = supabase.from('operators').select('*, teams ( id, name )').eq('production_line_id', lineId).order('full_name')
        if (teamId) q = q.eq('team_id', teamId)
        const { data: refreshed } = await q
        setOperators(refreshed ?? [])
      }
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : 'Import failed')
    }
    setImporting(false)
  }

  return (
    <div>
      <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 240, flex: 1 }}>
          <label className="label">Production Line</label>
          <select className="select" style={{ width: '100%' }} value={lineId} onChange={(e) => setLineId(e.target.value)}>
            <option value="">— Select —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        {lineId && (
          <div style={{ maxWidth: 240, flex: 1 }}>
            <label className="label">Team</label>
            <select className="select" style={{ width: '100%' }} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">All teams</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        {lineId && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={() => { setFormTeamId(teamId); setShowAdd(true) }}>+ Add Operator</button>
            <button className="btn-ghost" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? 'Importing…' : 'Import CSV'}</button>
          </div>
        )}
      </div>

      {importMsg && <p style={OK_BOX}>{importMsg}</p>}
      {importErr && <p style={ERR_BOX}>{importErr}</p>}

      {lineId && (
        <div className="card" style={{ overflow: 'hidden' }}>
          {loading ? <p style={EMPTY}>Loading…</p> : (
            <table className="data-table">
              <thead><tr><th>Name</th><th>Employee ID</th><th>Team</th><th>Status</th></tr></thead>
              <tbody>
                {operators.map((op) => (
                  <tr key={op.id}>
                    <td className="primary">{op.full_name}</td>
                    <td className="mono">{op.employee_id ?? '—'}</td>
                    <td>{op.teams ? <span className="badge badge-blue">{op.teams.name}</span> : <em style={{ color: 'var(--text-muted)', fontSize: 12 }}>Unassigned</em>}</td>
                    <td>{op.is_active ? <span className="badge badge-green">Active</span> : <span className="badge badge-grey">Inactive</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loading && operators.length === 0 && <p style={EMPTY}>No operators found</p>}
        </div>
      )}

      {showAdd && (
        <div className="card" style={{ padding: 20, marginTop: 16, maxWidth: 420 }}>
          <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label className="label">Full Name *</label>
              <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoFocus />
            </div>
            <div>
              <label className="label">Employee ID</label>
              <input className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
            </div>
            <div>
              <label className="label">Team</label>
              <select className="select" style={{ width: '100%' }} value={formTeamId} onChange={(e) => setFormTeamId(e.target.value)}>
                <option value="">— Unassigned —</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            {error && <p style={ERR_BOX}>{error}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
              <button type="submit" disabled={adding || !fullName.trim()} className="btn-primary">{adding ? 'Adding…' : 'Add Operator'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

// ── Tab 4: Products ─────────────────────────────────────────────────────
function ProductsTab({ supabase, lines }: { supabase: ReturnType<typeof createClient>; lines: ProductionLine[] }) {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [productCode, setProductCode] = useState('')
  const [model, setModel] = useState('')
  const [lineId, setLineId] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importErr, setImportErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function reload() {
    setLoading(true)
    supabase.from('products').select('*').order('model').then(({ data }) => { setProducts(data ?? []); setLoading(false) })
  }
  useEffect(reload, [supabase])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!productCode.trim() || !model.trim()) return
    setAdding(true); setError(null)
    const { data, error: err } = await supabase.from('products').insert({ product_code: productCode.trim(), model: model.trim(), production_line_id: lineId || null }).select('*').single()
    if (err) setError(err.message)
    else if (data) { setProducts((prev) => [...prev, data].sort((a, b) => a.model.localeCompare(b.model))); setProductCode(''); setModel(''); setLineId('') }
    setAdding(false)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true); setImportMsg(null); setImportErr(null)
    try {
      const rows = await readCsvFile(file)
      let skipped = 0
      const payload: Record<string, unknown>[] = []
      for (const r of rows) {
        if (!r.product_code?.trim() || !r.model?.trim()) { skipped++; continue }
        const line = lines.find((l) => l.name.toLowerCase() === (r.production_line_name ?? '').toLowerCase())
        payload.push({
          product_code: r.product_code.trim(),
          model: r.model.trim(),
          product_series: r.product_series?.trim() || null,
          year: r.year ? Number(r.year) : null,
          product_type: r.product_type?.trim() || null,
          productionfacility: r.productionfacility?.trim() || null,
          production_line_id: line?.id ?? null,
        })
      }
      if (payload.length > 0) {
        const { error: err } = await supabase.from('products').upsert(payload, { onConflict: 'product_code' })
        if (err) throw err
      }
      setImportMsg(`Processed ${payload.length}, skipped ${skipped}`)
      reload()
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : 'Import failed')
    }
    setImporting(false)
  }

  return (
    <div>
      <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display: 'none' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button className="btn-ghost" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? 'Importing…' : 'Import CSV'}</button>
      </div>
      {importMsg && <p style={OK_BOX}>{importMsg}</p>}
      {importErr && <p style={ERR_BOX}>{importErr}</p>}

      <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
        {loading ? <p style={EMPTY}>Loading…</p> : (
          <table className="data-table">
            <thead><tr><th>Code</th><th>Model</th><th>Series</th><th>Year</th><th>Production Line</th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.product_code}</td>
                  <td className="primary">{p.model}</td>
                  <td>{p.product_series ?? '—'}</td>
                  <td>{p.year ?? '—'}</td>
                  <td>{lines.find((l) => l.id === p.production_line_id)?.name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && products.length === 0 && <p style={EMPTY}>No products</p>}
      </div>

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: 120 }}><label className="label">Code</label><input className="input" value={productCode} onChange={(e) => setProductCode(e.target.value)} required /></div>
        <div style={{ flex: 1, minWidth: 180 }}><label className="label">Model</label><input className="input" value={model} onChange={(e) => setModel(e.target.value)} required /></div>
        <div style={{ minWidth: 180 }}>
          <label className="label">Production Line</label>
          <select className="select" style={{ width: '100%' }} value={lineId} onChange={(e) => setLineId(e.target.value)}>
            <option value="">— None —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <button type="submit" disabled={adding || !productCode.trim() || !model.trim()} className="btn-primary">{adding ? 'Adding…' : 'Add Product'}</button>
        {error && <p style={{ ...ERR_BOX, width: '100%' }}>{error}</p>}
      </form>
    </div>
  )
}

// ── Tab 5: Change Requests ──────────────────────────────────────────────
function RequestsTab({ supabase, userId }: { supabase: ReturnType<typeof createClient>; userId: string }) {
  const [requests, setRequests] = useState<OperatorChangeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [operators, setOperators] = useState<Operator[]>([])
  const [teams, setTeams] = useState<Team[]>([])

  const [operatorId, setOperatorId] = useState('')
  const [toTeamId, setToTeamId] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reload() {
    setLoading(true)
    supabase.from('operator_change_requests')
      .select('*, operators ( id, full_name ), from_team:from_team_id ( id, name ), to_team:to_team_id ( id, name ), requester:requested_by ( full_name )')
      .order('created_at', { ascending: false })
      .then(({ data }) => { setRequests((data ?? []) as unknown as OperatorChangeRequest[]); setLoading(false) })
  }

  useEffect(() => {
    reload()
    supabase.from('operators').select('*').order('full_name').then(({ data }) => setOperators(data ?? []))
    supabase.from('teams').select('*').order('name').then(({ data }) => setTeams(data ?? []))
  }, [supabase])

  const selectedOperator = operators.find((o) => o.id === operatorId) ?? null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!operatorId || !toTeamId) return
    setSubmitting(true); setError(null)
    const { error: err } = await supabase.from('operator_change_requests').insert({
      operator_id: operatorId, requested_by: userId, from_team_id: selectedOperator?.team_id ?? null, to_team_id: toTeamId, reason: reason.trim() || null,
    })
    if (err) setError(err.message)
    else { setOperatorId(''); setToTeamId(''); setReason(''); reload() }
    setSubmitting(false)
  }

  const statusBadge: Record<ChangeRequestStatus, string> = { pending: 'badge-amber', approved: 'badge-green', rejected: 'badge-grey' }

  return (
    <div>
      <div className="card" style={{ overflow: 'hidden', marginBottom: 24 }}>
        {loading ? <p style={EMPTY}>Loading…</p> : (
          <table className="data-table">
            <thead><tr><th>Operator</th><th>From</th><th>To</th><th>Reason</th><th>Requested By</th><th>Date</th><th className="right">Status</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="primary">{r.operators?.full_name ?? '—'}</td>
                  <td>{r.from_team?.name ?? '—'}</td>
                  <td>{r.to_team?.name ?? '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.reason ?? '—'}</td>
                  <td>{r.requester?.full_name ?? '—'}</td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td className="right"><span className={'badge ' + statusBadge[r.status]}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && requests.length === 0 && <p style={EMPTY}>No change requests</p>}
      </div>

      <div className="card" style={{ padding: 20, maxWidth: 480 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 14px' }}>Submit a Change Request</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="label">Operator *</label>
            <select className="select" style={{ width: '100%' }} value={operatorId} onChange={(e) => setOperatorId(e.target.value)} required>
              <option value="">— Select —</option>
              {operators.map((o) => <option key={o.id} value={o.id}>{o.full_name}</option>)}
            </select>
          </div>
          {selectedOperator && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Current team: {teams.find((t) => t.id === selectedOperator.team_id)?.name ?? 'Unassigned'}
            </p>
          )}
          <div>
            <label className="label">Move to Team *</label>
            <select className="select" style={{ width: '100%' }} value={toTeamId} onChange={(e) => setToTeamId(e.target.value)} required>
              <option value="">— Select —</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Reason</label>
            <textarea className="input" rows={3} style={{ resize: 'none' }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why should this operator move?" />
          </div>
          {error && <p style={ERR_BOX}>{error}</p>}
          <button type="submit" disabled={submitting || !operatorId || !toTeamId} className="btn-primary">{submitting ? 'Submitting…' : 'Submit Request'}</button>
        </form>
      </div>
    </div>
  )
}
