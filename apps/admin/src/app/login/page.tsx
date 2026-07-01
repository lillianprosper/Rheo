'use client'
import { useState, FormEvent } from 'react'
import { api, RheoApiError } from '@/lib/api'

export default function StaffLoginPage() {
  const [email,     setEmail]     = useState('')
  const [password,  setPassword]  = useState('')
  const [totp,      setTotp]      = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [error,     setError]     = useState('')
  const [loading,   setLoading]   = useState(false)

  function setSessionCookies(accessToken: string, refreshToken: string) {
    const secure = location.protocol === 'https:' ? ';Secure' : ''
    document.cookie = `rheo_access=${encodeURIComponent(accessToken)};Path=/;SameSite=Strict${secure}`
    document.cookie = `rheo_refresh=${encodeURIComponent(refreshToken)};Path=/;SameSite=Strict;Max-Age=${30*24*3600}${secure}`
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await api.auth.login(email, password, needsTotp ? totp : undefined)
      if (result.requiresTOTP) {
        setNeedsTotp(true)
        setLoading(false)
        return
      }
      if (result.accessToken && result.refreshToken) {
        setSessionCookies(result.accessToken, result.refreshToken)
        window.location.href = '/dashboard'
      }
    } catch (err) {
      setError(err instanceof RheoApiError ? err.error.message : 'Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#0F3020', padding:'2rem' }}>
      <div style={{ width:'100%', maxWidth:'400px' }}>
        <div style={{ textAlign:'center', marginBottom:'2rem' }}>
          <div style={{ fontFamily:'Georgia, serif', fontSize:'2rem', fontWeight:700, color:'#FFFFFF' }}>
            Rheo<span style={{ color:'#F5C842' }}>.</span>
          </div>
          <p style={{ color:'rgba(255,255,255,0.55)', marginTop:'0.5rem', fontSize:'0.85rem', letterSpacing:'0.08em', textTransform:'uppercase' }}>
            Staff Portal
          </p>
        </div>

        <div style={{ background:'#FFFFFF', borderRadius:'12px', padding:'2rem', boxShadow:'0 20px 50px rgba(0,0,0,0.3)' }}>
          <h1 style={{ marginBottom:'1.5rem', fontSize:'1.25rem', color:'#0F2018' }}>
            {needsTotp ? 'Enter your 2FA code' : 'Sign in'}
          </h1>

          {error && (
            <div style={{ background:'#FEE2E2', color:'#B91C1C', padding:'0.75rem 1rem', borderRadius:'8px', fontSize:'0.875rem', marginBottom:'1rem', borderLeft:'3px solid #DC2626' }}>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
            {!needsTotp ? (
              <>
                <div>
                  <label style={{ fontSize:'0.85rem', fontWeight:600, color:'#2C4A35', marginBottom:'0.4rem', display:'block' }} htmlFor="email">
                    Email
                  </label>
                  <input id="email" type="email"
                    style={{ width:'100%', padding:'0.7rem 0.9rem', border:'1px solid rgba(15,48,32,0.15)', borderRadius:'8px', fontSize:'0.95rem', boxSizing:'border-box' }}
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@rheoug.com" autoComplete="email" required />
                </div>
                <div>
                  <label style={{ fontSize:'0.85rem', fontWeight:600, color:'#2C4A35', marginBottom:'0.4rem', display:'block' }} htmlFor="password">
                    Password
                  </label>
                  <input id="password" type="password"
                    style={{ width:'100%', padding:'0.7rem 0.9rem', border:'1px solid rgba(15,48,32,0.15)', borderRadius:'8px', fontSize:'0.95rem', boxSizing:'border-box' }}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••" autoComplete="current-password" required />
                </div>
              </>
            ) : (
              <div>
                <label style={{ fontSize:'0.85rem', fontWeight:600, color:'#2C4A35', marginBottom:'0.4rem', display:'block' }} htmlFor="totp">
                  6-digit code from your authenticator app
                </label>
                <input id="totp" type="text" inputMode="numeric" maxLength={6}
                  style={{ width:'100%', padding:'0.7rem 0.9rem', border:'1px solid rgba(15,48,32,0.15)', borderRadius:'8px', fontSize:'1.4rem', letterSpacing:'0.3em', textAlign:'center', boxSizing:'border-box' }}
                  value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000" autoComplete="one-time-code" required />
              </div>
            )}

            <button type="submit" disabled={loading}
              style={{ marginTop:'0.5rem', padding:'0.8rem', background:'#1D5C38', color:'#FFFFFF', border:'none', borderRadius:'8px', fontSize:'0.95rem', fontWeight:600, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1 }}>
              {loading ? 'Verifying…' : needsTotp ? 'Verify and sign in' : 'Sign in'}
            </button>

            {needsTotp && (
              <button type="button" onClick={() => { setNeedsTotp(false); setTotp(''); setError('') }}
                style={{ background:'none', border:'none', color:'#4A6B55', fontSize:'0.85rem', cursor:'pointer', textAlign:'center' }}>
                ← Back to email and password
              </button>
            )}
          </form>
        </div>

        <p style={{ textAlign:'center', marginTop:'1.5rem', fontSize:'0.78rem', color:'rgba(255,255,255,0.4)' }}>
          Internal staff access only. All actions are logged and audited.
        </p>
      </div>
    </div>
  )
}
