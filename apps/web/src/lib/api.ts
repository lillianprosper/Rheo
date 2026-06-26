// ─── API client ───────────────────────────────────────────────────────────────
// All requests go through this client which:
//   1. Attaches the access token from cookies
//   2. Auto-refreshes on 401 and retries once
//   3. Redirects to /login on refresh failure

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'

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

async function refreshTokens(refreshToken: string, surface: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken, surface }),
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
  options: RequestInit = {},
  surface = 'business'
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
    const newAccess = await refreshTokens(refresh, surface)
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

export const api = {
  auth: {
    login: (email: string, password: string) =>
      apiFetch<{ accessToken: string; refreshToken: string; user: any }>('/auth/business/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }),
    logout: (refreshToken: string) =>
      apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  },
  dashboard: {
    summary:   () => apiFetch<any>('/analytics/business/summary'),
    liveQueue: () => apiFetch<any[]>('/analytics/business/live-queue'),
    billing:   () => apiFetch<any>('/analytics/business/billing'),
  },
  jobs: {
    list:    (page = 1, status?: string) =>
      apiFetch<any>(`/jobs/business?page=${page}${status ? `&status=${status}` : ''}`),
    get:     (id: string) => apiFetch<any>(`/jobs/${id}`),
    create:  (data: any) => apiFetch<any>('/jobs', { method: 'POST', body: JSON.stringify(data) }),
    cancel:  (id: string, reason: string) =>
      apiFetch(`/jobs/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  },
  business: {
    me:           () => apiFetch<any>('/businesses/me'),
    team:         () => apiFetch<any[]>('/businesses/me/team'),
    inviteMember: (data: any) =>
      apiFetch('/businesses/me/team/invite', { method: 'POST', body: JSON.stringify(data) }),
    removeMember: (id: string) =>
      apiFetch(`/businesses/me/team/${id}`, { method: 'DELETE' }),
    paymentMethods: () => apiFetch<any[]>('/businesses/me/payment-methods'),
    addPaymentMethod: (data: any) =>
      apiFetch('/businesses/me/payment-methods', { method: 'POST', body: JSON.stringify(data) }),
    notifications: (page = 1) =>
      apiFetch<any>(`/businesses/me/notifications?page=${page}`),
    readAllNotifications: () =>
      apiFetch('/businesses/me/notifications/read-all', { method: 'POST' }),
  },
  plans: {
    list: () => apiFetch<any[]>('/payments/plans'),
  },
}
