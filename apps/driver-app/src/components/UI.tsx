// ─── Shared UI primitives ─────────────────────────────────────────────────────
// All screens import from here — keeps visual consistency enforced.

import React from 'react'
import {
  View, Text, TouchableOpacity, ActivityIndicator,
  StyleSheet, ViewStyle, TextStyle,
} from 'react-native'
import { Colors, Spacing, Radius, Shadow } from '../lib/tokens'

// ─── Card ─────────────────────────────────────────────────────────────────────
export function Card({ children, style, accent }: {
  children: React.ReactNode
  style?:   ViewStyle
  accent?:  boolean
}) {
  return (
    <View style={[styles.card, accent && styles.cardAccent, style]}>
      {children}
    </View>
  )
}

// ─── Button ───────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'yellow' | 'ghost' | 'danger'

export function Button({ label, onPress, variant = 'primary', loading, disabled, style }: {
  label:     string
  onPress:   () => void
  variant?:  BtnVariant
  loading?:  boolean
  disabled?: boolean
  style?:    ViewStyle
}) {
  const btnStyle = {
    primary: styles.btnPrimary,
    yellow:  styles.btnYellow,
    ghost:   styles.btnGhost,
    danger:  styles.btnDanger,
  }[variant]

  const txtStyle = {
    primary: styles.btnTextLight,
    yellow:  styles.btnTextNavy,
    ghost:   styles.btnTextMuted,
    danger:  styles.btnTextLight,
  }[variant]

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      style={[styles.btn, btnStyle, (disabled || loading) && styles.btnDisabled, style]}
      activeOpacity={0.8}
    >
      {loading
        ? <ActivityIndicator color={variant === 'yellow' ? Colors.navy : Colors.white} size="small" />
        : <Text style={[styles.btnText, txtStyle]}>{label}</Text>}
    </TouchableOpacity>
  )
}

// ─── Status badge ─────────────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  queued:      { bg: '#F1F5F9', text: '#475569' },
  assigned:    { bg: Colors.skyPale,    text: '#075985' },
  picked_up:   { bg: Colors.yellowPale, text: '#92400E' },
  in_transit:  { bg: Colors.yellowPale, text: '#B45309' },
  delivered:   { bg: Colors.successBg,  text: '#166534' },
  failed:      { bg: Colors.dangerBg,   text: Colors.danger },
  cancelled:   { bg: '#F1F5F9',         text: '#6B7280' },
  pending:     { bg: Colors.yellowPale, text: '#92400E' },
  approved:    { bg: Colors.navyLight,  text: Colors.navyMid },
  suspended:   { bg: Colors.dangerBg,   text: Colors.danger },
}

export function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] || { bg: '#F1F5F9', text: '#6B7280' }
  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.badgeText, { color: colors.text }]}>
        {status.replace(/_/g, ' ').toUpperCase()}
      </Text>
    </View>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────
export function SectionHeader({ title, action, onAction }: {
  title:     string
  action?:   string
  onAction?: () => void
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action && onAction && (
        <TouchableOpacity onPress={onAction}>
          <Text style={styles.sectionAction}>{action}</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────
export function EmptyState({ icon, title, subtitle }: {
  icon:      string
  title:     string
  subtitle?: string
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle && <Text style={styles.emptySubtitle}>{subtitle}</Text>}
    </View>
  )
}

// ─── Info row ─────────────────────────────────────────────────────────────────
export function InfoRow({ label, value, mono }: {
  label: string; value: string; mono?: boolean
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && { fontFamily: 'Courier' }]}>{value}</Text>
    </View>
  )
}

// ─── Divider ──────────────────────────────────────────────────────────────────
export function Divider() {
  return <View style={styles.divider} />
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.card,
  },
  cardAccent: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.navyBase,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    minHeight: 52,  // Large tap target — outdoor mobile use
  },
  btnPrimary: { backgroundColor: Colors.navyBase },
  btnYellow:  { backgroundColor: Colors.yellow },
  btnGhost:   { backgroundColor: 'transparent', borderWidth: 1, borderColor: Colors.borderStrong },
  btnDanger:  { backgroundColor: Colors.danger },
  btnDisabled:{ opacity: 0.5 },
  btnText:    { fontSize: 15, fontWeight: '700' as const, letterSpacing: 0.3 },
  btnTextLight:{ color: Colors.white },
  btnTextNavy: { color: Colors.navy },
  btnTextMuted:{ color: Colors.inkMuted },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
    marginTop: Spacing.md,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700' as const,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: Colors.inkSubtle,
  },
  sectionAction: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: Colors.navyBase,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: Spacing.xl,
  },
  emptyIcon:     { fontSize: 40, marginBottom: Spacing.md, opacity: 0.4 },
  emptyTitle:    { fontSize: 17, fontWeight: '600' as const, color: Colors.ink, textAlign: 'center', marginBottom: Spacing.sm },
  emptySubtitle: { fontSize: 14, color: Colors.inkMuted, textAlign: 'center', lineHeight: 20 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  infoLabel: { fontSize: 13, color: Colors.inkMuted },
  infoValue: { fontSize: 13, fontWeight: '600' as const, color: Colors.ink },
  divider:   { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
})
