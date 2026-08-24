import jsPDF from 'jspdf'
import { fmtDate } from './format'

export interface JobPdfNote {
  content: string
  author: string | null
  date: string
}

export interface JobPdfOperation {
  name: string
  primaryOperatorName: string | null
  secondaryOperatorName: string | null
  avgMinutes: number | null
  runCount: number
  collectionDates: string[]
  notes: JobPdfNote[]
}

export interface JobPdfData {
  jobName: string
  teamName: string | null
  productionLineName: string | null
  operations: JobPdfOperation[]
}

/** Mirrors the layout of the original Word-doc timing record: job name, every
 * operation with its primary/secondary operators, team + production line,
 * average minutes, collection dates, and notes. */
export function generateJobPdf(data: JobPdfData) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 48
  let y = 0

  function ensureSpace(next: number) {
    if (y + next > pageHeight - margin) {
      doc.addPage()
      y = margin
    }
  }

  // Header bar
  doc.setFillColor(0, 121, 193)
  doc.rect(0, 0, pageWidth, 64, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text('J-Motion — Job Timing Record', margin, 40)

  y = 100
  doc.setTextColor(20, 20, 20)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(data.jobName, margin, y)
  y += 24

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(80, 80, 80)
  doc.text(`Team: ${data.teamName ?? '—'}    Production line: ${data.productionLineName ?? '—'}`, margin, y)
  y += 24

  doc.setDrawColor(228, 231, 236)
  doc.line(margin, y, pageWidth - margin, y)
  y += 24

  if (data.operations.length === 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(11)
    doc.setTextColor(140, 140, 140)
    doc.text('No operations recorded for this job.', margin, y)
  }

  for (const op of data.operations) {
    ensureSpace(90)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(0, 121, 193)
    doc.text(op.name, margin, y)
    y += 18

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10.5)
    doc.setTextColor(20, 20, 20)
    const operators = [
      op.primaryOperatorName ? `Primary: ${op.primaryOperatorName}` : null,
      op.secondaryOperatorName ? `Secondary: ${op.secondaryOperatorName}` : null,
    ].filter(Boolean).join('    ')
    if (operators) { doc.text(operators, margin, y); y += 16 }

    const avgText = op.avgMinutes != null ? `${op.avgMinutes.toFixed(1)} min avg` : 'Not yet timed'
    doc.text(`${avgText}    (${op.runCount} run${op.runCount === 1 ? '' : 's'})`, margin, y)
    y += 16

    if (op.collectionDates.length > 0) {
      doc.setTextColor(80, 80, 80)
      doc.text(`Collected: ${op.collectionDates.map(fmtDate).join(', ')}`, margin, y)
      doc.setTextColor(20, 20, 20)
      y += 16
    }

    if (op.notes.length > 0) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9.5)
      doc.text('Notes', margin, y)
      y += 13
      doc.setFont('helvetica', 'normal')
      for (const note of op.notes) {
        ensureSpace(28)
        const lines = doc.splitTextToSize(note.content, pageWidth - margin * 2 - 10)
        doc.setTextColor(20, 20, 20)
        doc.text(lines, margin + 10, y)
        y += lines.length * 12
        doc.setFontSize(8.5)
        doc.setTextColor(140, 140, 140)
        doc.text(`${note.author ?? 'Unknown'} — ${fmtDate(note.date)}`, margin + 10, y)
        doc.setFontSize(9.5)
        y += 14
      }
    }

    y += 10
    doc.setDrawColor(240, 240, 240)
    doc.line(margin, y, pageWidth - margin, y)
    y += 20
  }

  const safeName = data.jobName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  doc.save(`job-${safeName || 'record'}.pdf`)
}
