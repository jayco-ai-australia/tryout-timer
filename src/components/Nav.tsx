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

  return (
    <nav style={{
      background: 'var(--surface)',
      borderBottom: '1.5px solid var(--border)',
      position: 'sticky',
      top: 0,
      zIndex: 50,
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    }}>
      <div style={{
        maxWidth: 1200,
        margin: '0 auto',
        padding: '0 16px',
        height: 56,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        {/* Logo */}
        <Link href="/dashboard" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          textDecoration: 'none',
          color: 'var(--blue)',
          fontWeight: 700,
          fontSize: 17,
          letterSpacing: '-0.01em',
        }}>
          <StopwatchIcon />
          TryOut Timer
        </Link>

        {/* Links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {[
            { href: '/dashboard', label: 'Dashboard' },
            { href: '/analytics', label: 'Analytics' },
            ...(role === 'admin' ? [{ href: '/admin', label: 'Admin' }] : []),
          ].map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              style={{
                fontSize: 14,
                fontWeight: 600,
                padding: '6px 12px',
                borderRadius: 7,
                textDecoration: 'none',
                transition: 'background 0.12s, color 0.12s',
                background: isActive(href) ? 'var(--blue-light)' : 'transparent',
                color: isActive(href) ? 'var(--blue)' : 'var(--text-mid)',
              }}
            >
              {label}
            </Link>
          ))}

          <button
            onClick={handleLogout}
            style={{
              marginLeft: 8,
              fontSize: 14,
              fontWeight: 600,
              padding: '6px 12px',
              borderRadius: 7,
              border: '1.5px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-mid)',
              cursor: 'pointer',
              transition: 'background 0.12s',
            }}
          >
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
