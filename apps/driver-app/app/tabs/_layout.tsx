import { useEffect } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import { AuthProvider, useAuth } from '../src/store/auth'

function RootNavigator() {
  const { isLoggedIn, isLoading } = useAuth()
  const segments = useSegments()
  const router   = useRouter()

  useEffect(() => {
    if (isLoading) return
    const inAuthGroup = segments[0] === '(auth)'
    if (!isLoggedIn && !inAuthGroup) router.replace('/(auth)/login')
    if (isLoggedIn  &&  inAuthGroup) router.replace('/(tabs)/board')
  }, [isLoggedIn, isLoading, segments])

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  )
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  )
}
