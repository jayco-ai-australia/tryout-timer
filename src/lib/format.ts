export function fmtClock(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "1 August 2026" — no leading zero on the day. Built from the date parts rather than
 * `new Date(iso)` so a plain YYYY-MM-DD column isn't read as UTC midnight and shown as the
 * previous day west of Greenwich. */
export function fmtLongDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function fmtMinutes(minutes: number | null | undefined): string {
  return minutes != null ? minutes.toFixed(1) : '—'
}

/** Minutes as hours, 1–2dp (2dp under 10h, where a tenth of an hour is a bigger relative
 * swing) — used wherever a labour total is shown alongside its minutes figure. */
export function fmtHours(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  const hours = minutes / 60
  return hours < 10 ? hours.toFixed(2) : hours.toFixed(1)
}
