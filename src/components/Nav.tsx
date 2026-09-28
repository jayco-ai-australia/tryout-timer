'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import { canAccessAdminArea } from '@/lib/permissions'
import AddTimeDrawer from '@/components/AddTimeDrawer'
import type { UserRole } from '@/lib/types'

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const [role, setRole] = useState<UserRole | null>(null)
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
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single()
      if (data) setRole(data.role as UserRole)
    })
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  const links = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/setup', label: 'Setup' },
    // "Structure", NOT "Config" — /config already exists further along and is the admin-only
    // application settings screen; two links reading "Config" in one nav is a mis-click waiting
    // to happen. One word rather than "Line Structure" because this bar has no room to spare:
    // for an admin it carries eleven links plus Add Time and Logout inside a 1200px shell, and
    // the two-word version was enough to wrap it onto a second row.
    { href: '/line-config', label: 'Structure' },
    { href: '/collect', label: 'Collect' },
    { href: '/tryouts', label: 'Try Outs' },
    { href: '/model-total', label: 'Model Total' },
    // "Matrix", not "Labour Matrix": this bar is already at capacity (see the Structure note
    // above) and the two-word version pushes it onto a second row on a 1200px shell. It sits
    // directly after Model Total, which is the context that makes the one word unambiguous —
    // the matrix IS Model Total for every model on the line at once.
    { href: '/labour-matrix', label: 'Matrix' },
    { href: '/reports', label: 'Reports' },
    // "Pre-Assembly", not the route's full name: this bar is already at capacity (see the
    // Structure note above), and it sits directly beside Reports, which is the context that
    // makes the short label unambiguous.
    { href: '/pre-assembly-coverage', label: 'Pre-Assembly' },
    { href: '/roadmap', label: 'Roadmap' },
    // Admin only — a manager sees neither link, matching the middleware and the page's own
    // re-check. Hiding a link is not a permission; these are gated in all three places.
    ...(canAccessAdminArea(role) ? [{ href: '/config', label: 'Config' }] : []),
    ...(canAccessAdminArea(role) ? [{ href: '/admin', label: 'Admin' }] : []),
    { href: '/profile', label: 'Profile' },
  ]

  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link href="/dashboard" className="nav-logo">
          <StopwatchIcon />
          J-Motion
        </Link>

        <div className="nav-links">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={isActive(href) ? 'nav-link nav-link-active' : 'nav-link'}
            >
              {label}
            </Link>
          ))}

          <button
            type="button"
            className="nav-add-time"
            onClick={() => setAddTimeOpen(true)}
            title="Enter a time collected on paper"
          >
            <span aria-hidden="true">+</span> Add Time
          </button>

          <button onClick={handleLogout} className="nav-logout">
            Logout
          </button>
        </div>
      </div>

      {addTimeOpen && <AddTimeDrawer onDone={() => setAddTimeOpen(false)} />}
    </nav>
  )
}

function StopwatchIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8" />
      <polyline points="12 9 12 13 14.5 15.5" />
      <path d="M9 3h6" />
      <path d="M12 3v2" />
    </svg>
  )
}
