// ─── Driver API client ────────────────────────────────────────────────────────
// STRIDE: Information Disclosure — tokens stored in Expo SecureStore only.
// Never use AsyncStorage for auth tokens — it is not encrypted on Android.

import * as SecureStore from 'expo-secure-store'

const API = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000/api/v1'

const KEYS = {
  access:  'rheo_driver_access',
  refresh: 'rheo_driver_refresh',
  driverId:'rheo_driver_id',
}

export async function getTokens() {
  const [access, refresh, driverId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.access),
    SecureStore.getItemAsync(KEYS.refresh),
    SecureStore.getItemAsync(KEYS.driverId),
  ])
  return { access, refresh, driverId }
}

export async function setTokens(access: string, refresh: string, driverId: string) {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.access,   access),
    SecureStore.setItemAsync(KEYS.refresh,  refresh),
    SecureStore.setItemAsync(KEYS.driverId, driverId),
  ])
}

export async function clearTokens() {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.access),
    SecureStore.deleteItemAsync(KEYS.refresh),
    SecureStore.deleteItemAsync(KEYS.driverId),
  ])
}

async function refreshAccessToken(): Promise<string | null> {
  const { refresh } = await getTokens()
  if (!refresh) return null
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken: refresh, surface: 'driver' }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const { driverId } = await getTokens()
    await setTokens(data.data.accessToken, data.data.refreshToken, driverId || '')
    return data.data.accessToken
  } catch { return null }
}

export class DriverApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { access, refresh } = await getTokens()

  const makeRequest = async (token: string | null) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(`${API}${path}`, { ...options, headers })
  }

  let res = await makeRequest(access)

  if (res.status === 401 && refresh) {
    const newAccess = await refreshAccessToken()
    if (!newAccess) {
      await clearTokens()
      throw new DriverApiError(401, 'SESSION_EXPIRED', 'Session expired')
    }
    res = await makeRequest(newAccess)
  }

  const data = await res.json()
  if (!res.ok) {
    throw new DriverApiError(
      res.status,
      data.error?.code || 'UNKNOWN',
      data.error?.message || 'Something went wrong'
    )
  }
  return data.data as T
}

// ─── Typed API surface ────────────────────────────────────────────────────────

export const api = {
  auth: {
    login: (phone: string, password: string) =>
      apiFetch<{ accessToken: string; refreshToken: string; driver: any }>('/auth/driver/login', {
        method: 'POST', body: JSON.stringify({ phone, password }),
      }),
    logout: async () => {
      const { refresh } = await getTokens()
      if (refresh) {
        await apiFetch('/auth/logout', {
          method: 'POST', body: JSON.stringify({ refreshToken: refresh }),
        }).catch(() => {})
      }
      await clearTokens()
    },
  },
  driver: {
    me:       () => apiFetch<any>('/drivers/me'),
    setOnline:(online: boolean) =>
      apiFetch('/drivers/me', {
        method: 'PATCH',
        body:   JSON.stringify({ isOnline: online }),
      }),
    uploadDoc:(formData: FormData) =>
      fetch(`${API}/drivers/me/documents`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${(async () => (await getTokens()).access)()}` },
        body:    formData,
      }),
  },
  board: {
    list: () => apiFetch<any[]>('/jobs/board'),
    accept:(id: string) =>
      apiFetch<any>(`/jobs/board/${id}/accept`, { method: 'POST' }),
  },
  job: {
    active:    () => apiFetch<any>('/jobs/me/active'),
    history:   (page = 1) => apiFetch<any>(`/jobs/me/history?page=${page}`),
    setStatus: (id: string, status: string, notes?: string) =>
      apiFetch(`/jobs/${id}/status`, {
        method: 'POST', body: JSON.stringify({ status, notes }),
      }),
    submitPod: async (id: string, photoUri: string, notes?: string) => {
      const formData = new FormData()
      formData.append('photo', { uri: photoUri, type: 'image/jpeg', name: 'pod.jpg' } as any)
      if (notes) formData.append('notes', notes)
      const { access } = await getTokens()
      return fetch(`${API}/jobs/${id}/pod`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${access}` },
        body:    formData,
      })
    },
    sendLocation: async (jobId: string, lat: number, lng: number) => {
      const { access } = await getTokens()
      // Fire-and-forget — never await on the main thread
      fetch(`${API}/jobs/tracking/location`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${access}`,
        },
        body: JSON.stringify({ jobId, lat, lng }),
      }).catch(() => {}) // Swallow — network blips are expected on mobile
    },
  },
  wallet: {
    me:          () => apiFetch<any>('/drivers/me/wallet'),
    withdraw:    (amountUgx: number, paymentMethodId: string) =>
      apiFetch('/drivers/me/withdrawals', {
        method: 'POST', body: JSON.stringify({ amountUgx, paymentMethodId }),
      }),
    addMethod:   (data: any) =>
      apiFetch('/drivers/me/payment-methods', {
        method: 'POST', body: JSON.stringify(data),
      }),
  },
}
