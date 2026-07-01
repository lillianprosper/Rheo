// ─── Admin API client ─────────────────────────────────────────────────────────
// Same pattern as apps/web's client, adapted for staff auth + mandatory 2FA flow.
//   1. Attaches the access token from cookies
//   2. Auto-refreshes on 401 and retries once
//   3. Redirects to /login on refresh failure

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'
const SURFACE = 'staff'

function getTokens() {
  if (typeof document === 'undefined') return { access: null, refresh: null }
  const cookies = Object.fromEntries(
    document.cookie.split(';').map((c) => c.trim().split('=').map(decodeURIComponent))
  )
  return { access: cookies['rheo_access'] || null, refresh: cookies['rheo_refresh'] || null }
}

function setTokens(access: string, refresh: string) {
  const secure = location.protocol === 'https:' ? ';Secure' : ''
  document.cookie = `rheo_access=${encodeURIComponent(access)};Path=/;SameSite=Strict${secure}`
  document.cookie = `rheo_refresh=${encodeURIComponent(refresh)};Path=/;SameSite=Strict;Max-Age=${30*24*3600}${secure}`
}

function clearTokens() {
  document.cookie = 'rheo_access=;Path=/;Max-Age=0'
  document.cookie = 'rheo_refresh=;Path=/;Max-Age=0'
}

async function refreshTokens(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken, surface: SURFACE }),
    })
    if (!res.ok) return null
    const data = await res.json()
    setTokens(data.data.accessToken, data.data.refreshToken)
    return data.data.accessToken
  } catch {
    return null
  }
}

export interface ApiError {
  message: string
  code:    string
  fields?: Array<{ field: string; message: string }>
}

export class RheoApiError extends Error {
  constructor(
    public status: number,
    public error:  ApiError
  ) {
    super(error.message)
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const { access, refresh } = getTokens()

  const makeRequest = async (token: string | null) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    return fetch(`${API}${path}`, { ...options, headers })
  }

  let res = await makeRequest(access)

  // Auto-refresh on 401
  if (res.status === 401 && refresh) {
    const newAccess = await refreshTokens(refresh)
    if (!newAccess) {
      clearTokens()
      if (typeof window !== 'undefined') window.location.href = '/login'
      throw new RheoApiError(401, { message: 'Session expired', code: 'SESSION_EXPIRED' })
    }
    res = await makeRequest(newAccess)
  }

  const data = await res.json()

  if (!res.ok) {
    throw new RheoApiError(res.status, data.error || { message: 'Unknown error', code: 'UNKNOWN' })
  }

  return data.data as T
}

// ─── Typed API calls ──────────────────────────────────────────────────────────

interface StaffLoginResult {
  requiresTOTP?: boolean
  accessToken?:  string
  refreshToken?: string
  user?: {
    id: string
    email: string
    firstName: string
    lastName: string
    role: string
  }
}

export const api = {
  auth: {
    // Staff login is two-step when 2FA is enabled:
    //   1st call (no totp) -> { requiresTOTP: true } if 2FA is on, or full tokens if not
    //   2nd call (with totp) -> full tokens
    login: (email: string, password: string, totp?: string) =>
      apiFetch<StaffLoginResult>('/auth/staff/login', {
        method: 'POST',
        body: JSON.stringify(totp ? { email, password, totp } : { email, password }),
      }),
    logout: (refreshToken: string) =>
      apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  },
  admin: {
    dashboard: () => apiFetch<any>('/admin/dashboard'),
    staff: {
      list:   (page = 1, params: Record<string, string> = {}) => {
        const qs = new URLSearchParams({ page: String(page), ...params }).toString()
        return apiFetch<any>(`/admin/staff?${qs}`)
      },
      create: (data: any) => apiFetch<any>('/admin/staff', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: string, data: any) =>
        apiFetch<any>(`/admin/staff/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      setPermission: (id: string, permission: string, granted: boolean) =>
        apiFetch(`/admin/staff/${id}/permissions`, {
          method: 'POST', body: JSON.stringify({ permission, granted }),
        }),
    },
    kyc: {
      queue:  (type: 'driver' | 'business' = 'driver') =>
        apiFetch<any>(`/admin/kyc/queue?type=${type}`),
      review: (type: 'driver' | 'business', id: string, action: 'approve' | 'reject', notes?: string) =>
        apiFetch<any>(`/admin/kyc/${type}/${id}/review`, {
          method: 'POST', body: JSON.stringify({ action, notes }),
        }),
    },
    auditLogs: (page = 1, params: Record<string, string> = {}) => {
      const qs = new URLSearchParams({ page: String(page), ...params }).toString()
      return apiFetch<any>(`/admin/audit-logs?${qs}`)
    },
    payroll: {
      list:   (page = 1, params: Record<string, string> = {}) => {
        const qs = new URLSearchParams({ page: String(page), ...params }).toString()
        return apiFetch<any>(`/admin/payroll?${qs}`)
      },
      create: (data: any) => apiFetch<any>('/admin/payroll', { method: 'POST', body: JSON.stringify(data) }),
    },
    config: () => apiFetch<any>('/admin/config'),
  },
}
