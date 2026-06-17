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

  const linkClass = (href: string) =>
    `text-sm font-medium px-3 py-1.5 rounded-md transition-colors ${
      pathname === href || pathname.startsWith(href + '/')
        ? 'bg-white/20 text-white'
        : 'text-white/80 hover:text-white hover:bg-white/10'
    }`

  return (
    <nav className="bg-[#0079c1] shadow-md sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Logo */}
        <Link href="/dashboard" className="flex items-center gap-2 text-white font-bold text-lg">
          <StopwatchIcon />
          <span>TryOut Timer</span>
        </Link>

        {/* Links */}
        <div className="flex items-center gap-1">
          <Link href="/dashboard" className={linkClass('/dashboard')}>
            Dashboard
          </Link>
          <Link href="/analytics" className={linkClass('/analytics')}>
            Analytics
          </Link>
          {role === 'admin' && (
            <Link href="/admin" className={linkClass('/admin')}>
              Admin
            </Link>
          )}
          <button
            onClick={handleLogout}
            className="ml-2 text-sm font-medium text-white/80 hover:text-white px-3 py-1.5 rounded-md hover:bg-white/10 transition-colors"
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
