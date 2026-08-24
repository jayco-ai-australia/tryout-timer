/** Minimal quoted-field-aware CSV parser. First row is treated as the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = splitRows(text)
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim())
  return rows.slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => {
      const obj: Record<string, string> = {}
      header.forEach((key, i) => { obj[key] = (row[i] ?? '').trim() })
      return obj
    })
}

function splitRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field); field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }

  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}
