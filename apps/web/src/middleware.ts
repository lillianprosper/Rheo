import { NextRequest, NextResponse } from 'next/server'

// ─── Route protection middleware ──────────────────────────────────────────────
// STRIDE: Elevation of Privilege — all /dashboard/* routes require a valid
// session. We check for the presence of the refresh token cookie (longer-lived).
// The actual JWT verification happens at the API — middleware only redirects.

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password']

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Allow public paths and Next.js internals
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next()
  }

  const refreshToken = req.cookies.get('rheo_refresh')?.value

  if (!refreshToken) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('from', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
