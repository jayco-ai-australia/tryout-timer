'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { canAccessAdminArea } from '@/lib/permissions'
import AddTimeDrawer from '@/components/AddTimeDrawer'
import type { UserRole } from '@/lib/types'

/**
 * The app's navigation — a sidebar.
 *
 * ── Modes ─────────────────────────────────────────────────────────────────────────────────
 * DESKTOP (≥ 1280px): always docked down the left, in one of two widths —
 *   EXPANDED  232px, every link labelled under its group heading.
 *   RAIL       64px, one icon per GROUP. Clicking a group opens a flyout beside the rail listing
 *              that group's links (the SugarCRM pattern). The flyout closes on picking a link, on
 *              a click anywhere else, and on Escape.
 * A toggle at the foot switches between the two and the choice is remembered per device.
 *
 * NARROW (< 1280px): a slim top bar with a menu button; the expanded panel slides over the
 * content and closes on picking a link, on the backdrop, and on Escape. No rail here — below
 * 1280px the width goes to the page, and a tablet has the room for a slide-over.
 *
 * ── Why the width is an attribute on <html> ───────────────────────────────────────────────
 * The rail/expanded state is `data-nav="rail"` on the root element, and the CSS keys off that
 * alone. The root layout sets it from localStorage in an inline script BEFORE first paint, so a
 * page load never renders expanded and then snaps to the rail on hydration — that snap was half
 * the jolt. This component keeps the attribute in step afterwards.
 *
 * The other half was the transition itself. It now animates `width` between a fixed pair of
 * values (232 ↔ 64) on the column and `padding-left` between the same pair on <body>, with the
 * same duration and easing, so the content moves in step with the column. Nothing is measured
 * per frame and nothing remounts: both layouts (labelled list, icon rail) are always in the tree
 * at fixed widths and cross-fade, so neither one reflows while the column's width changes.
 * Transitions are only switched on (`data-nav-anim`) after the first frame, so the initial
 * state is never animated in.
 *
 * ── /labour-matrix ────────────────────────────────────────────────────────────────────────
 * That grid scrolls sideways and wants every pixel, so it OPENS on the rail whatever the saved
 * preference is. Expanding it there lasts for that visit and does not change the preference.
 *
 * The root keeps the `.nav` class so the existing print rules (globals.css and
 * report-print.css both hide `.nav`) take all of it — bar, column, flyout — off paper.
 */

interface NavItem { href: string; label: string; icon: ReactNode }
interface NavGroup { key: string; heading: string; icon: ReactNode; items: NavItem[] }

/** Matches the docked breakpoint in globals.css. */
const DOCK_QUERY = '(min-width: 1280px)'
/** Also spelled out in the inline script in app/layout.tsx (a server component can't import a
 * value from this client module) — keep the two in step. */
const NAV_PREF_KEY = 'jmotion.nav.rail'
const MATRIX_PATH = '/labour-matrix'

function readPref(): boolean {
  try { return window.localStorage.getItem(NAV_PREF_KEY) === '1' } catch { return false }
}
function writePref(rail: boolean) {
  try { window.localStorage.setItem(NAV_PREF_KEY, rail ? '1' : '0') } catch { /* private mode: not remembered */ }
}

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const [role, setRole] = useState<UserRole | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  /**
   * The global add-a-time entry point.
   *
   * It lives in the nav because it is the ONE path that has to exist from wherever somebody
   * happens to be standing — a paper form gets typed up from whatever screen is open, not by
   * navigating to the right model first. Launched with no props, so the drawer opens blank and
   * the user picks their way down: line → team → section → job. Screens that already know some
   * of that (/model-total) render the same component themselves with it pre-filled.
   *
   * Not gated on role: entering a time you collected is the base job of every signed-in user.
   */
  const [addTimeOpen, setAddTimeOpen] = useState(false)
  /** Narrow only: whether the panel is slid in. */
  const [open, setOpen] = useState(false)
  /** Desktop: the saved preference for the rail. */
  const [railPref, setRailPref] = useState(false)
  /** /labour-matrix only: expanded for this visit, overriding its rail default. */
  const [matrixExpanded, setMatrixExpanded] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)
  /** The group whose flyout is open in rail mode, and where to put it. */
  const [flyout, setFlyout] = useState<{ key: string; top: number } | null>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  const onMatrix = pathname === MATRIX_PATH || pathname.startsWith(MATRIX_PATH + '/')
  const rail = railPref || (onMatrix && !matrixExpanded)
  const railActive = isDesktop && rail

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      setEmail(user.email ?? null)
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()
      if (data) setRole(data.role as UserRole)
    })
  }, [])

  // The preference, and — one frame after it is applied — transitions on. Two frames so the
  // browser has painted the settled state before anything is allowed to animate.
  useEffect(() => {
    setRailPref(readPref())
    const mq = window.matchMedia(DOCK_QUERY)
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => document.documentElement.setAttribute('data-nav-anim', ''))
    })
    return () => {
      mq.removeEventListener('change', update)
      cancelAnimationFrame(raf1); cancelAnimationFrame(raf2)
    }
  }, [])

  // The attribute the CSS reads. The layout's inline script set it before first paint; from
  // here on this owns it.
  useEffect(() => {
    const root = document.documentElement
    if (rail) root.setAttribute('data-nav', 'rail')
    else root.removeAttribute('data-nav')
  }, [rail])

  // A route change closes the drawer and any flyout, and ends a visit's "expanded on the matrix".
  useEffect(() => {
    setOpen(false)
    setFlyout(null)
    setMatrixExpanded(false)
  }, [pathname])

  // A flyout only exists beside the rail.
  useEffect(() => { if (!railActive) setFlyout(null) }, [railActive])

  // Escape closes whichever overlay is up; a press outside the flyout closes it. The group
  // button that opened it is excluded so clicking it again toggles rather than close-then-reopen.
  useEffect(() => {
    if (!open && !flyout) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false); setFlyout(null)
    }
    const onDown = (e: MouseEvent) => {
      if (!flyout) return
      const target = e.target as Element | null
      if (flyoutRef.current?.contains(target)) return
      if (target?.closest?.(`[data-nav-group="${flyout.key}"]`)) return
      setFlyout(null)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, flyout])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  function toggleRail() {
    setFlyout(null)
    if (rail) {
      if (railPref) { setRailPref(false); writePref(false) }
      if (onMatrix) setMatrixExpanded(true)
    } else if (onMatrix) {
      setMatrixExpanded(false)
    } else {
      setRailPref(true); writePref(true)
    }
  }

  function toggleFlyout(key: string, button: HTMLElement) {
    if (flyout?.key === key) { setFlyout(null); return }
    // One read, on the click — never per frame.
    setFlyout({ key, top: button.getBoundingClientRect().top })
  }

  function openAddTime() {
    setOpen(false); setFlyout(null); setAddTimeOpen(true)
  }

  // Admin only — a manager sees neither link, matching the middleware and the page's own
  // re-check. Hiding a link is not a permission; these are gated in all three places.
  const isAdmin = canAccessAdminArea(role)

  const groups: NavGroup[] = [
    {
      key: 'collecting',
      heading: 'Collecting',
      icon: <TimerIcon />,
      items: [
        { href: '/collect', label: 'Collect', icon: <ClipboardCheckIcon /> },
        { href: '/tryouts', label: 'Try Outs', icon: <TruckIcon /> },
      ],
    },
    {
      key: 'reviewing',
      heading: 'Reviewing',
      icon: <BarChartIcon />,
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: <LayoutGridIcon /> },
        { href: '/model-total', label: 'Model Total', icon: <SigmaIcon /> },
        { href: '/labour-matrix', label: 'Labour Matrix', icon: <TableIcon /> },
        { href: '/reports', label: 'Reports', icon: <FileTextIcon /> },
        { href: '/pre-assembly-coverage', label: 'Pre-Assembly Coverage', icon: <PackageIcon /> },
      ],
    },
    {
      key: 'structure',
      heading: 'Structure',
      icon: <LayersIcon />,
      items: [
        { href: '/setup', label: 'Setup', icon: <WrenchIcon /> },
        // The page's own title is "Production Line Config"; under its own heading, apart from
        // the admin-only Config, it can say what the page says.
        { href: '/line-config', label: 'Line Config', icon: <NetworkIcon /> },
      ],
    },
    {
      // "Settings", not "Admin": everybody sees Roadmap and Profile.
      key: 'settings',
      heading: 'Settings',
      icon: <GearIcon />,
      items: [
        { href: '/roadmap', label: 'Roadmap', icon: <MapIcon /> },
        ...(isAdmin ? [{ href: '/config', label: 'Config', icon: <SlidersIcon /> }] : []),
        ...(isAdmin ? [{ href: '/admin', label: 'Admin', icon: <ShieldIcon /> }] : []),
        { href: '/profile', label: 'Profile', icon: <UserIcon /> },
      ],
    },
  ]

  const flyoutGroup = flyout ? groups.find((g) => g.key === flyout.key) ?? null : null

  function itemLink({ href, label, icon }: NavItem) {
    const active = isActive(href)
    return (
      <Link
        key={href}
        href={href}
        className={active ? 'nav-link nav-link-active' : 'nav-link'}
        aria-current={active ? 'page' : undefined}
        onClick={() => { setOpen(false); setFlyout(null) }}
      >
        <span className="nav-icon">{icon}</span>
        <span className="nav-link-label">{label}</span>
      </Link>
    )
  }

  return (
    <nav className={'nav' + (open ? ' nav-open' : '')} aria-label="Main">
      {/* Narrow screens' bar. Hidden by CSS while docked. */}
      <div className="nav-topbar">
        <button
          type="button"
          className="nav-menu-btn"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
        >
          <MenuIcon />
        </button>
        <Link href="/dashboard" className="nav-logo">
          <StopwatchIcon />
          J-Motion
        </Link>
        <button
          type="button"
          className="nav-add-time"
          style={{ marginLeft: 'auto' }}
          onClick={openAddTime}
          title="Enter a time collected on paper"
        >
          <span aria-hidden="true">+</span> Add Time
        </button>
      </div>

      <div className="nav-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />

      <div className="nav-sidebar">
        <div className="nav-sidebar-head">
          <Link href="/dashboard" className="nav-logo" title="J-Motion">
            <span className="nav-logo-mark"><StopwatchIcon /></span>
            <span className="nav-link-label">J-Motion</span>
          </Link>
          {/* Narrow only — the slide-over's close. */}
          <button type="button" className="nav-sidebar-close" onClick={() => setOpen(false)} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>

        <div className="nav-sidebar-body">
          {/* EXPANDED: labelled links under group headings. Fixed width; clipped and faded out
              while the rail shows, never reflowed. */}
          <div className="nav-full" aria-hidden={railActive || undefined}>
            <div className="nav-sidebar-action">
              <button
                type="button"
                className="nav-add-time"
                onClick={openAddTime}
                title="Enter a time collected on paper"
                tabIndex={railActive ? -1 : undefined}
              >
                <span aria-hidden="true">+</span> Add Time
              </button>
            </div>
            <div className="nav-groups">
              {groups.map((group) => (
                <div key={group.key} className="nav-group">
                  <div className="nav-group-heading">{group.heading}</div>
                  <div className="nav-group-items">
                    {group.items.map(itemLink)}
                  </div>
                </div>
              ))}
            </div>
            <div className="nav-sidebar-foot">
              {email && <div className="nav-user" title={email}>{email}</div>}
              <button onClick={handleLogout} className="nav-logout" tabIndex={railActive ? -1 : undefined}>
                Logout
              </button>
            </div>
          </div>

          {/* RAIL: one icon per group, each opening a flyout. Desktop only (CSS). */}
          <div className="nav-rail" aria-hidden={!railActive || undefined}>
            <button
              type="button"
              className="nav-rail-btn nav-rail-add"
              onClick={openAddTime}
              title="Add Time — enter a time collected on paper"
              aria-label="Add Time"
              tabIndex={railActive ? undefined : -1}
            >
              <PlusIcon />
            </button>
            <div className="nav-rail-groups">
              {groups.map((group) => {
                const active = group.items.some((i) => isActive(i.href))
                const isOpen = flyout?.key === group.key
                return (
                  <button
                    key={group.key}
                    type="button"
                    data-nav-group={group.key}
                    className={'nav-rail-btn' + (active ? ' nav-rail-btn-active' : '') + (isOpen ? ' nav-rail-btn-open' : '')}
                    onClick={(e) => toggleFlyout(group.key, e.currentTarget)}
                    title={group.heading}
                    aria-label={group.heading}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    tabIndex={railActive ? undefined : -1}
                  >
                    {group.icon}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              className="nav-rail-btn"
              onClick={handleLogout}
              title={email ? `Logout (${email})` : 'Logout'}
              aria-label="Logout"
              tabIndex={railActive ? undefined : -1}
            >
              <LogoutIcon />
            </button>
          </div>
        </div>

        {/* Desktop only — the rail/expanded switch. Sits in the left 64px so it stays put in
            both widths; its label is simply clipped away on the rail. */}
        <div className="nav-toggle-row">
          <button
            type="button"
            className="nav-toggle"
            onClick={toggleRail}
            aria-label={rail ? 'Expand menu' : 'Collapse menu to icons'}
            title={rail ? 'Expand menu' : 'Collapse menu to icons'}
          >
            <span className="nav-icon">{rail ? <ChevronsRightIcon /> : <ChevronsLeftIcon />}</span>
            <span className="nav-link-label">Collapse</span>
          </button>
        </div>
      </div>

      {flyoutGroup && flyout && (
        <div
          ref={flyoutRef}
          className="nav-flyout"
          role="menu"
          aria-label={flyoutGroup.heading}
          // Kept on screen: a group low in a short window opens upward rather than off the bottom.
          style={{ top: Math.max(8, Math.min(flyout.top, window.innerHeight - (flyoutGroup.items.length * 38 + 48))) }}
        >
          <div className="nav-group-heading">{flyoutGroup.heading}</div>
          <div className="nav-flyout-items">{flyoutGroup.items.map(itemLink)}</div>
        </div>
      )}

      {addTimeOpen && <AddTimeDrawer onDone={() => setAddTimeOpen(false)} />}
    </nav>
  )
}

// ── Icons ────────────────────────────────────────────────────────────────────────────────
// Inline, like every other icon in the app — there is no icon package and this adds none. The
// paths follow Lucide's 24px stroke set (ISC licence) so they read as one family at 18–20px.

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

function StopwatchIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="13" r="8" />
      <polyline points="12 9 12 13 14.5 15.5" />
      <path d="M9 3h6" />
      <path d="M12 3v2" />
    </svg>
  )
}
function MenuIcon() { return <Icon><path d="M4 6h16M4 12h16M4 18h16" /></Icon> }
function CloseIcon() { return <Icon size={18}><path d="M18 6L6 18M6 6l12 12" /></Icon> }
function PlusIcon() { return <Icon><path d="M12 5v14M5 12h14" /></Icon> }
function ChevronsLeftIcon() { return <Icon size={18}><path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" /></Icon> }
function ChevronsRightIcon() { return <Icon size={18}><path d="m6 17 5-5-5-5" /><path d="m13 17 5-5-5-5" /></Icon> }
function LogoutIcon() {
  return <Icon><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" x2="9" y1="12" y2="12" /></Icon>
}

// Groups
function TimerIcon() {
  return <Icon><line x1="10" x2="14" y1="2" y2="2" /><line x1="12" x2="15" y1="14" y2="11" /><circle cx="12" cy="14" r="8" /></Icon>
}
function BarChartIcon() {
  return <Icon><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></Icon>
}
function LayersIcon() {
  return (
    <Icon>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </Icon>
  )
}
function GearIcon() {
  return (
    <Icon>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  )
}

// Items
function ClipboardCheckIcon() {
  return <Icon><rect width="8" height="4" x="8" y="2" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></Icon>
}
function TruckIcon() {
  return (
    <Icon>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Icon>
  )
}
function LayoutGridIcon() {
  return <Icon><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></Icon>
}
function SigmaIcon() {
  return <Icon><path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2" /></Icon>
}
function TableIcon() {
  return <Icon><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /><path d="M15 3v18" /></Icon>
}
function FileTextIcon() {
  return <Icon><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M16 13H8" /><path d="M16 17H8" /><path d="M10 9H8" /></Icon>
}
function PackageIcon() {
  return (
    <Icon>
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </Icon>
  )
}
function WrenchIcon() {
  return <Icon><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></Icon>
}
function NetworkIcon() {
  return <Icon><rect x="16" y="16" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="9" y="2" width="6" height="6" rx="1" /><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" /><path d="M12 12V8" /></Icon>
}
function MapIcon() {
  return (
    <Icon>
      <path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" />
      <path d="M15 5.764v15" />
      <path d="M9 3.236v15" />
    </Icon>
  )
}
function SlidersIcon() {
  return (
    <Icon>
      <line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" />
    </Icon>
  )
}
function ShieldIcon() {
  return <Icon><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></Icon>
}
function UserIcon() {
  return <Icon><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Icon>
}
