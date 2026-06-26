import React, { useState } from 'react'
import {
  View, Text, TextInput, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, TouchableOpacity,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useAuth } from '../../store/auth'
import { Button } from '../../components/UI'
import { Colors, Spacing, Radius } from '../../lib/tokens'
import { DriverApiError } from '../../lib/api'

export default function LoginScreen() {
  const router  = useRouter()
  const { login } = useAuth()
  const [phone,    setPhone]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleLogin() {
    if (!phone.trim() || !password.trim()) {
      setError('Please enter your phone number and password')
      return
    }
    setError('')
    setLoading(true)
    try {
      await login(phone.trim(), password)
      router.replace('/(tabs)/board')
    } catch (err) {
      setError(err instanceof DriverApiError ? err.message : 'Login failed. Check your details.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>
            Rheo<Text style={{ color: Colors.sky }}>.</Text>
          </Text>
          <Text style={styles.tagline}>Driver portal</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.formTitle}>Sign in</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Phone number</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="+256 700 000 000"
              placeholderTextColor={Colors.inkSubtle}
              keyboardType="phone-pad"
              autoComplete="tel"
              returnKeyType="next"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={Colors.inkSubtle}
              secureTextEntry
              autoComplete="password"
              returnKeyType="done"
              onSubmitEditing={handleLogin}
            />
          </View>

          <Button
            label="Sign in"
            onPress={handleLogin}
            variant="yellow"
            loading={loading}
            style={{ marginTop: Spacing.sm }}
          />

          <TouchableOpacity style={styles.forgotLink}>
            <Text style={styles.forgotText}>Forgot password? Contact Rheo support</Text>
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          Not registered yet? Apply at rheoug.com/driver-app
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.navy },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: Spacing.lg,
    paddingTop: Spacing.xxl,
  },
  header: { alignItems: 'center', marginBottom: Spacing.xl },
  logo: {
    fontSize: 36,
    fontWeight: '700',
    color: Colors.white,
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.4)',
    marginTop: 4,
  },
  form: {
    backgroundColor: Colors.white,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  formTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: Spacing.md,
  },
  errorBox: {
    backgroundColor: Colors.dangerBg,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.danger,
  },
  errorText: { color: Colors.danger, fontSize: 13, fontWeight: '500' },
  fieldGroup: { marginBottom: Spacing.md },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.inkMuted,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.sm,
    padding: 14,
    fontSize: 15,
    color: Colors.ink,
    backgroundColor: Colors.white,
    minHeight: 52,
  },
  forgotLink: { alignItems: 'center', marginTop: Spacing.md },
  forgotText: { fontSize: 13, color: Colors.inkSubtle },
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
    lineHeight: 18,
  },
})
