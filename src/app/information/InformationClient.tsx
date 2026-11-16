'use client'

import { usePageSetup } from '@/lib/usePageSetup'

/**
 * The Information document. The wording is the handover copy, verbatim — see page.tsx. Only the
 * typesetting is this file's: headings, the hierarchy drawn as nested levels rather than as
 * box-drawing characters, and a contents list built from the copy's own headings.
 *
 * The five <section>s are the copy's five top-level parts (it separates them with rules and gives
 * them no titles of their own, so neither does the page).
 */

/** This page's paper, kept identical to ./print.css. Module-level so usePageSetup's effect runs
 * once per mount. */
const INFORMATION_PAGE_CSS = '@page { size: A4 portrait; margin: 16mm 18mm; }'

const CONTENTS: { id: string; label: string }[] = [
  { id: 'structure', label: 'The structure' },
  { id: 'applicability', label: 'Applicability — which work applies to which model' },
  { id: 'structure-first', label: 'Why the line structure comes first' },
  { id: 'collecting', label: 'The three ways to collect a time' },
  { id: 'combining', label: 'How several records on one operation combine' },
  { id: 'reading', label: 'Reading the times' },
  { id: 'trustworthy', label: 'What makes a figure trustworthy' },
]

const LEVELS: { name: string; examples: string; role?: string }[] = [
  {
    name: 'Production Line',
    examples: 'Caravan, Motor Home, Campervan, Pop Top, JPod, and the pre-assembly areas — Chassis, Lamination, Sew, Saws',
  },
  { name: 'Team', examples: 'Team 1, Team 2, Cab, Quality', role: 'who does the work' },
  { name: 'Section', examples: 'Floor Installation, Gas Plumbing, Main Door', role: 'a stage of the build' },
  { name: 'Job', examples: 'Floor Install, Vinyl Lay and Final Finish', role: 'a unit of work within that stage' },
  { name: 'Operation', examples: 'Drill bolt holes, Install Vinyl', role: 'the individual step a time is recorded against' },
]

export default function InformationClient() {
  const pinPageSetup = usePageSetup(INFORMATION_PAGE_CSS)

  function handlePrint() {
    pinPageSetup()
    window.print()
  }

  return (
    <main className="info-page">
      <div className="info-toolbar">
        <button type="button" className="btn-ghost" onClick={handlePrint}>Print</button>
      </div>

      <article className="info-doc">
        {/* ── 1 ─────────────────────────────────────────────────────────────────────────── */}
        <section className="info-part info-intro">
          <h1 className="info-title">How J-Motion works</h1>
          <p className="info-lede">
            J-Motion records how long work takes on the production line, model by model, so that labour
            cost can be built from measured evidence rather than estimate.
          </p>
          <p>
            Everything in it rests on one idea: <strong>a time belongs to a piece of work, and to the
            models of van it applies to.</strong> The rest of the system exists to make that statement precise.
          </p>

          <nav className="info-contents" aria-label="Contents">
            <p className="info-contents-head">Contents</p>
            <ol>
              {CONTENTS.map((c) => (
                <li key={c.id}><a href={`#${c.id}`}>{c.label}</a></li>
              ))}
            </ol>
          </nav>
        </section>

        {/* ── 2 ─────────────────────────────────────────────────────────────────────────── */}
        <section className="info-part">
          <h2 id="structure">The structure</h2>
          <p>Work is described in five levels. Each one sits inside the one above it.</p>

          <ol className="info-tree" aria-label="The five levels, outermost first">
            {LEVELS.map((l, i) => (
              <li key={l.name} className="info-tree-level" style={{ marginLeft: `${i * 28}px` }}>
                <span className="info-tree-name">{l.name}</span>
                <span className="info-tree-desc">
                  {l.examples}
                  {l.role && <> — <em>{l.role}</em></>}
                </span>
              </li>
            ))}
          </ol>

          <p>
            <strong>A time is always recorded against an Operation.</strong> Jobs, Sections and Teams
            don’t hold times themselves — their figures are the sum of the operations beneath them.
          </p>

          <h2 id="applicability">Applicability — which work applies to which model</h2>
          <p>Not every operation is done on every model. A slide-out doesn’t exist on a van without one.</p>
          <p>
            So each operation is linked to the models it applies to. That link is what makes the operation
            countable for that model.
          </p>
          <p>
            An operation that is linked to no model is <strong>invisible to the figures</strong>. It doesn’t
            appear as a gap on Model Total or the Labour Matrix, and it doesn’t count toward coverage — as far
            as the figures are concerned, that work isn’t done on any van.
          </p>
          <p>
            The same is true one level up. A job’s applicability comes entirely from its operations, so{' '}
            <strong>a job with no operations applies to nothing</strong>. It won’t appear on Model Total or the
            Labour Matrix at all. Structure Review flags it as having no operations.
          </p>
          <p>
            Coverage is measured as <strong>job × model</strong>: how many of the jobs that apply to a model
            have a time against them.
          </p>

          <h3>Saying “not applicable”</h3>
          <p>
            On the Estimate screen you can mark a cell as work that isn’t done on that model, and that decision
            is recorded and respected there.
          </p>
          <p>
            Elsewhere in the app it looks the same as a cell nobody has decided about, and linking the
            operation to the model on another screen will override it. So it’s a judgement held on one screen,
            not a fact the whole system defends.
          </p>

          <h2 id="structure-first">Why the line structure comes first</h2>
          <p>
            The structure decides what can be measured. Before collecting anything on a line, the structure
            has to be right, because:
          </p>
          <ul>
            <li>Work that isn’t in the structure can’t be timed, and won’t appear as missing</li>
            <li>An operation linked to no model never counts as a gap</li>
            <li>A job with no operations doesn’t appear on Model Total or the Labour Matrix</li>
            <li>Operations that duplicate each other split the evidence between them, so neither looks well-measured</li>
            <li>Operations too fine-grained to time reliably produce numbers nobody trusts</li>
          </ul>
          <p className="info-callout">
            Getting this wrong doesn’t produce visible errors. It produces confident figures that quietly
            describe less work than you think.
          </p>
          <p>
            <strong>Structure Review is the document for checking this.</strong> It shows the whole structure
            in one place, including the parts the figures leave out.
          </p>
        </section>

        {/* ── 3 ─────────────────────────────────────────────────────────────────────────── */}
        <section className="info-part">
          <h2 id="collecting">The three ways to collect a time</h2>
          <p>
            The real difference between them is <strong>what the time is tied to</strong>, not whether a
            stopwatch was used. Try Outs and Collect both offer a stopwatch and typed entry.
          </p>

          <h3>Try Outs — timed against a van</h3>
          <p>
            A specific van, by chassis number. The time is saved against the operation and that chassis. The
            operator and a note about anything unusual can be added too.
          </p>
          <p>
            This is the strongest evidence in the system, because the figure can be traced back to a
            particular van on a particular day.
          </p>
          <p>
            Because Try Outs knows which van it’s on, it’s the only place J-Motion can tell that a time
            already exists for that work on that van. When one does, it asks whether this is a correction or
            separate work — two operators in parallel, say. Nowhere else can ask, because nowhere else knows
            the van.
          </p>

          <h3>Collect — timed against the work</h3>
          <p>The same operation, without tying the time to a particular van.</p>
          <p>
            Useful for work that isn’t van-specific, and for recording a figure when the chassis isn’t to hand.
            It counts as a measured time.
          </p>
          <p className="info-callout">
            <strong>One thing to know:</strong> because these times aren’t tied to a van, J-Motion can’t tell
            two of them apart from two halves of one job. Record the same operation and model twice through
            Collect and the figures <strong>add together</strong>. If you’re re-recording rather than adding,
            correct the first one in the times drawer instead.
          </p>

          <h3>Estimate — extrapolation</h3>
          <p>A figure for a model nobody has timed, worked out from models that have been.</p>
          <p>
            If Floor Install takes 55 minutes on one Adventurer, the other Adventurers are unlikely to be far
            off, and the person who knows the line can say so with more confidence than anyone else.
          </p>
          <p>
            The figure is typed by a person — J-Motion doesn’t calculate it. The screen puts the measured
            models in front of you to reason from, and gives you tools to copy a column across a range, but
            the judgement is yours.
          </p>
          <p>
            Estimates are flagged as estimates. They count toward labour exactly as a measured time does —
            it’s still the work — but they can be told apart, so coverage can be read as “x% measured, y%
            estimated” rather than a single number that hides the difference. A job counts as estimated for a
            model only when <strong>every</strong> time behind it is an estimate.
          </p>
          <p className="info-callout">
            <strong>The order matters.</strong> Measure first, extrapolate second. An estimate made before
            anything was measured is a guess with a timestamp.
          </p>

          <h2 id="combining">How several records on one operation combine</h2>
          <p>
            More than one record can exist for the same operation on the same model. How they combine depends
            on whether they describe the same work or different parts of it.
          </p>
          <ul>
            <li>
              <strong>Records on the same van add together.</strong> Two operators working in parallel, or an
              operation that absorbed others when it was merged, both produce several records of one job.
              Their total is what that van took.
            </li>
            <li>
              <strong>Records with no van also add together</strong>, for the same reason the system can’t
              tell them apart. See the note under Collect.
            </li>
            <li>
              <strong>Totals from different vans are averaged.</strong> Each van is one observation of the
              same work.
            </li>
            <li>
              <strong>A record that has been replaced doesn’t count</strong> toward the minutes.
            </li>
          </ul>
          <p>
            Correcting a time through Try Outs changes the figure on the existing record. A record is marked as
            replaced when someone makes an earlier record current again in the times drawer. Deleting removes
            a record outright, and is limited to managers and admins.
          </p>
        </section>

        {/* ── 4 ─────────────────────────────────────────────────────────────────────────── */}
        <section className="info-part">
          <h2 id="reading">Reading the times</h2>

          <h3>By model</h3>
          <p>
            Everything recorded for one model, broken down by team, section and job: what’s been timed, what
            hasn’t, and the total labour for a van of that model.
          </p>
          <p>
            This is the view for the question <em>“what does this van cost, and what don’t we know yet?”</em>
          </p>

          <h3>By section — the Labour Matrix</h3>
          <p>
            One production line’s models as a grid, grouped by product type and series. The columns can be
            switched between Team, Section and Job.
          </p>
          <p>
            This is the view for <em>“where are the gaps across the range?”</em> — a column of untimed cells
            tells you where to send someone with a stopwatch.
          </p>
          <p>
            The total on this screen adds every model on the grid together, so it’s labour across the whole
            range, not the labour on one van.
          </p>

          <h3>Structure Review</h3>
          <p>
            A printed document of the whole structure — every section, job and operation, with minutes per
            van, how many models have a figure, and how many recordings sit behind it.
          </p>
          <p>
            Built to be taken onto the floor and marked up by hand when reviewing whether the structure is
            right. It also flags jobs with no operations.
          </p>
          <p className="info-callout">
            Its minutes are <strong>per van</strong>. The Labour Matrix total is <strong>across all
            models</strong>. Both are correct; they answer different questions.
          </p>
        </section>

        {/* ── 5 ─────────────────────────────────────────────────────────────────────────── */}
        <section className="info-part">
          <h2 id="trustworthy">What makes a figure trustworthy</h2>
          <p>
            A number in J-Motion is worth what the evidence behind it is worth. Four things to look at before
            relying on one:
          </p>
          <ol className="info-numbered">
            <li><strong>How many recordings sit behind it.</strong> One is a data point. Eight is a standard.</li>
            <li><strong>Measured or estimated.</strong> Both count. They don’t carry the same weight.</li>
            <li><strong>Whether it’s tied to a van.</strong> A time against a chassis can be traced back. One without can’t.</li>
            <li>
              <strong>Whether the notes say anything.</strong> “Two operators on this one”, “new starter”,
              “slide-out model” — the note written at the time is usually why a figure looks odd. Notes can be
              added later, so it’s never too late to record why.
            </li>
          </ol>
        </section>
      </article>
    </main>
  )
}
