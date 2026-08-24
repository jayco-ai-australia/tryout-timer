'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import type { UserRole } from '@/lib/types'

export default function Nav() {
  const pathname = usePathname()
  const router = useRouter()
  const [role, setRole] = useState<UserRole | null>(null)
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
    { href: '/collect', label: 'Collect' },
    { href: '/tryouts', label: 'Try Outs' },
    { href: '/model-total', label: 'Model Total' },
    { href: '/roadmap', label: 'Roadmap' },
    ...(role === 'admin' ? [{ href: '/config', label: 'Config' }] : []),
    ...(role === 'admin' ? [{ href: '/admin', label: 'Admin' }] : []),
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

          <button onClick={handleLogout} className="nav-logout">
            Logout
          </button>
        </div>
      </div>
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
