'use client'
import { usePathname, useRouter } from 'next/navigation'
import { api } from '@/lib/api'

const NAV = [
  { href: '/dashboard',            label: 'Overview',   icon: '⬡' },
  { href: '/dashboard/jobs',       label: 'Jobs',       icon: '📦' },
  { href: '/dashboard/analytics',  label: 'Analytics',  icon: '📊' },
  { href: '/dashboard/settings',   label: 'Settings',   icon: '⚙' },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router   = useRouter()

  async function handleLogout() {
    const cookies = Object.fromEntries(
      document.cookie.split(';').map((c) => c.trim().split('=').map(decodeURIComponent))
    )
    if (cookies['rheo_refresh']) {
      await api.auth.logout(cookies['rheo_refresh']).catch(() => {})
    }
    document.cookie = 'rheo_access=;Path=/;Max-Age=0'
    document.cookie = 'rheo_refresh=;Path=/;Max-Age=0'
    router.push('/login')
  }

  return (
    <div className="dashboard-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo display">
          Rheo<span>.</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => {
            const active = item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${active ? 'active' : ''}`}
              >
                <span style={{ fontSize: '1rem' }}>{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div style={{ padding: '0 1.25rem 1rem' }}>
          <button
            onClick={handleLogout}
            className="nav-item"
            style={{ width: '100%', cursor: 'pointer', background: 'none', border: 'none', textAlign: 'left' }}
          >
            <span style={{ fontSize: '1rem' }}>↩</span>
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="main-content">{children}</main>
    </div>
  )
}
