import React, { useState, useEffect, useCallback } from 'react'
import { AuthContext, DriverUser } from './auth'
import { api, getTokens, clearTokens, setTokens } from '../lib/api'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [driver,    setDriver]    = useState<DriverUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // On mount — check for existing session
  useEffect(() => {
    const init = async () => {
      try {
        const { access } = await getTokens()
        if (access) {
          const me = await api.driver.me()
          setDriver(mapDriver(me))
        }
      } catch {
        await clearTokens()
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [])

  const login = useCallback(async (phone: string, password: string) => {
    const res = await api.auth.login(phone, password)
    await setTokens(res.accessToken, res.refreshToken, res.driver.id)
    setDriver(mapDriver(res.driver))
  }, [])

  const logout = useCallback(async () => {
    await api.auth.logout()
    setDriver(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const me = await api.driver.me()
      setDriver(mapDriver(me))
    } catch {
      await clearTokens()
      setDriver(null)
    }
  }, [])

  return (
    <AuthContext.Provider value={{
      driver, isLoading, isLoggedIn: !!driver, login, logout, refresh,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

function mapDriver(raw: any): DriverUser {
  return {
    id:          raw.id,
    firstName:   raw.first_name,
    lastName:    raw.last_name,
    phone:       raw.phone,
    status:      raw.status,
    kycStatus:   raw.kyc_status,
    isOnline:    raw.is_online,
    avatarUrl:   raw.avatar_url,
    vehicleType: raw.vehicle_type,
    plateNumber: raw.plate_number,
  }
}
