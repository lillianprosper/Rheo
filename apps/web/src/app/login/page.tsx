'use client'
import { useState, FormEvent, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, RheoApiError } from '@/lib/api'

// ─── Extracted into its own component so useSearchParams()
//     is safely inside a Suspense boundary (Next.js 14 requirement).
//     Without this, the entire page degrades to client-side rendering,
//     killing middleware-based auth checks and SSR performance.
function LoginContent() {
  const searchParams = useSearchParams()
  const from         = searchParams.get('from') || '/dashboard'

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { accessToken, refreshToken } = await api.auth.login(email, password)
      const secure = location.protocol === 'https:' ? ';Secure' : ''
      // NOTE: Move cookie-setting to an API route with HttpOnly flag
      // before going to production with real users — JS-accessible cookies
      // are vulnerable to XSS token theft.
      document.cookie = `rheo_access=${encodeURIComponent(accessToken)};Path=/;SameSite=Strict${secure}`
      document.cookie = `rheo_refresh=${encodeURIComponent(refreshToken)};Path=/;SameSite=Strict;Max-Age=${30*24*3600}${secure}`
      // FIX: hard navigation instead of router.push(from).
      // router.push is a soft client-side navigation and re-serves the
      // /dashboard payload the router prefetched while logged OUT (the
      // 304s in the Network tab), so the sign-in card appeared to "stay
      // open" even after a successful 200. A full-page navigation bypasses
      // the client router cache entirely, so middleware and server
      // components see the fresh auth cookies on first render.
      window.location.assign(from)
    } catch (err) {
      setError(err instanceof RheoApiError ? err.error.message : 'Unable to connect. Please try again.')
      setLoading(false)
    }
    // Deliberately NOT clearing `loading` on success — the page is
    // navigating away; re-enabling the button would allow a double submit.
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--cream)', padding:'2rem' }}>
      <div style={{ width:'100%', maxWidth:'400px' }}>
        <div style={{ textAlign:'center', marginBottom:'2rem' }}>
          <div className="display" style={{ fontSize:'2rem', fontWeight:700, color:'var(--forest-dark)' }}>
            Rheo<span style={{ color:'var(--yellow)' }}>.</span>
          </div>
          <p style={{ color:'var(--ink-muted)', marginTop:'0.5rem', fontSize:'0.9rem' }}>Business portal</p>
        </div>
        <div className="card">
          <div className="card-body" style={{ padding:'2rem' }}>
            <h1 style={{ marginBottom:'1.5rem', fontSize:'1.25rem' }}>Sign in</h1>
            {error && (
              <div style={{ background:'#FEE2E2', color:'#B91C1C', padding:'0.75rem 1rem', borderRadius:'var(--radius-sm)', fontSize:'0.875rem', marginBottom:'1rem', borderLeft:'3px solid #DC2626' }}>
                {error}
              </div>
            )}
            <form onSubmit={handleSubmit} style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
              <div className="form-group">
                <label className="form-label" htmlFor="email">Email</label>
                <input id="email" type="email" className="form-input" value={email}
                  onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
                  autoComplete="email" required />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="password">Password</label>
                <input id="password" type="password" className="form-input" value={password}
                  onChange={(e) => setPassword(e.target.value)} placeholder="••••••••"
                  autoComplete="current-password" required />
              </div>
              <button type="submit" className="btn btn-primary" disabled={loading}
                style={{ marginTop:'0.5rem', justifyContent:'center', padding:'0.75rem' }}>
                {loading
                  ? <span style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
                      <span className="spinner" style={{ width:16, height:16 }} />Signing in…
                    </span>
                  : 'Sign in'}
              </button>
            </form>
            <p style={{ textAlign:'center', marginTop:'1.5rem', fontSize:'0.8rem', color:'var(--ink-subtle)' }}>
              Forgot your password? <a href="/forgot-password" style={{ color:'var(--forest)', fontWeight:600 }}>Reset it</a>
            </p>
          </div>
        </div>
        <p style={{ textAlign:'center', marginTop:'1.5rem', fontSize:'0.8rem', color:'var(--ink-subtle)' }}>
          New to Rheo? <a href="/register" style={{ color:'var(--forest)', fontWeight:600 }}>Create an account</a>
        </p>
      </div>
    </div>
  )
}

// ─── Suspense boundary isolates useSearchParams() so Next.js can
//     prerender the shell statically and hydrate only the search-param
//     dependent logic on the client. Fallback matches the page bg so
//     there is zero layout shift on load.
export default function LoginPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--cream)' }}>
        <span className="spinner" style={{ width:32, height:32 }} />
      </div>
    }>
      <LoginContent />
    </Suspense>
  )
}
