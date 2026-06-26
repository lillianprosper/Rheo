// ─── Auth state store ─────────────────────────────────────────────────────────
// Lightweight React context — no Redux needed for this app's complexity level.
// Persists tokens to SecureStore; in-memory state for UI reactivity.

import { createContext, useContext } from 'react'

export interface DriverUser {
  id:          string
  firstName:   string
  lastName:    string
  phone:       string
  status:      string
  kycStatus:   string
  isOnline:    boolean
  avatarUrl?:  string
  vehicleType?: string
  plateNumber?: string
}

export interface AuthState {
  driver:     DriverUser | null
  isLoading:  boolean
  isLoggedIn: boolean
}

export interface AuthActions {
  login:   (phone: string, password: string) => Promise<void>
  logout:  () => Promise<void>
  refresh: () => Promise<void>
}

export const AuthContext = createContext<(AuthState & AuthActions) | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
