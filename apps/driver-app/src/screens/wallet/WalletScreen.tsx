import React, { useEffect, useState, useCallback } from 'react'
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  TextInput, Alert,
} from 'react-native'
import { api, DriverApiError } from '../../lib/api'
import { Card, Button, SectionHeader, InfoRow, EmptyState } from '../../components/UI'
import { Colors, Spacing, Radius } from '../../lib/tokens'

interface Wallet {
  balance_ugx:        number
  pending_ugx:        number
  total_earned_ugx:   number
  total_withdrawn_ugx:number
  min_withdraw_ugx:   number
}

function fmtUgx(n: any) { return `UGX ${Number(n||0).toLocaleString()}` }

function TxTypeIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    earning: '💰', withdrawal: '📤', bonus: '🎁', adjustment: '🔧',
  }
  return <Text style={{ fontSize: 18 }}>{icons[type] || '💳'}</Text>
}

export default function WalletScreen() {
  const [wallet,       setWallet]       = useState<Wallet | null>(null)
  const [transactions, setTransactions] = useState<any[]>([])
  const [paymentMethods, setPaymentMethods] = useState<any[]>([])
  const [loading,      setLoading]      = useState(true)
  const [refreshing,   setRefreshing]   = useState(false)
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawing,  setWithdrawing]  = useState(false)
  const [showWithdraw, setShowWithdraw] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.wallet.me()
      setWallet(data.wallet)
      setTransactions(data.transactions || [])
      setPaymentMethods(data.pendingWithdrawals || [])
    } catch {} finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleWithdraw() {
    const amount = parseFloat(withdrawAmount)
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Invalid amount', 'Enter a valid withdrawal amount')
      return
    }
    if (!wallet || amount > wallet.balance_ugx) {
      Alert.alert('Insufficient balance', `Your balance is ${fmtUgx(wallet?.balance_ugx)}`)
      return
    }
    if (wallet && amount < wallet.min_withdraw_ugx) {
      Alert.alert('Below minimum', `Minimum withdrawal is ${fmtUgx(wallet.min_withdraw_ugx)}`)
      return
    }

    setWithdrawing(true)
    try {
      await api.wallet.withdraw(amount, 'default')
      Alert.alert('Withdrawal requested! ✅', 'Your funds will be sent to your mobile money account within 24 hours.')
      setWithdrawAmount('')
      setShowWithdraw(false)
      await load()
    } catch (err) {
      Alert.alert('Failed', err instanceof DriverApiError ? err.message : 'Withdrawal failed')
    } finally {
      setWithdrawing(false)
    }
  }

  if (loading) {
    return <EmptyState icon="💳" title="Loading wallet…" />
  }

  const w = wallet!

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} tintColor={Colors.navyBase} />
      }
    >
      {/* Balance hero */}
      <View style={styles.balanceHero}>
        <Text style={styles.balanceLabel}>Available balance</Text>
        <Text style={styles.balanceAmount}>{fmtUgx(w.balance_ugx)}</Text>
        {w.pending_ugx > 0 && (
          <Text style={styles.pendingText}>
            + {fmtUgx(w.pending_ugx)} pending
          </Text>
        )}
        <Button
          label="Withdraw funds"
          onPress={() => setShowWithdraw(!showWithdraw)}
          variant="yellow"
          style={styles.withdrawBtn}
        />
      </View>

      {/* Withdraw form */}
      {showWithdraw && (
        <Card style={styles.withdrawForm}>
          <Text style={styles.withdrawTitle}>Request withdrawal</Text>
          <Text style={styles.withdrawSub}>
            Min: {fmtUgx(w.min_withdraw_ugx)} · Balance: {fmtUgx(w.balance_ugx)}
          </Text>
          <TextInput
            style={styles.amountInput}
            value={withdrawAmount}
            onChangeText={setWithdrawAmount}
            placeholder="Enter amount (UGX)"
            placeholderTextColor={Colors.inkSubtle}
            keyboardType="numeric"
          />
          <Button
            label="Submit withdrawal"
            onPress={handleWithdraw}
            variant="primary"
            loading={withdrawing}
            style={{ marginTop: Spacing.sm }}
          />
        </Card>
      )}

      {/* Stats */}
      <SectionHeader title="Summary" />
      <Card>
        <InfoRow label="Total earned"     value={fmtUgx(w.total_earned_ugx)} />
        <InfoRow label="Total withdrawn"  value={fmtUgx(w.total_withdrawn_ugx)} />
        <InfoRow label="Pending payout"   value={fmtUgx(w.pending_ugx)} />
      </Card>

      {/* Transactions */}
      <SectionHeader title="Recent transactions" />
      {transactions.length === 0 ? (
        <EmptyState icon="📋" title="No transactions yet" subtitle="Your earnings will appear here after completing jobs" />
      ) : (
        <Card>
          {transactions.map((tx: any, i: number) => (
            <View key={tx.id} style={[styles.txRow, i === transactions.length-1 && { borderBottomWidth: 0 }]}>
              <View style={styles.txLeft}>
                <TxTypeIcon type={tx.type} />
                <View style={styles.txInfo}>
                  <Text style={styles.txDesc}>{tx.description || tx.type}</Text>
                  <Text style={styles.txDate}>{new Date(tx.created_at).toLocaleDateString('en-UG')}</Text>
                </View>
              </View>
              <Text style={[
                styles.txAmount,
                { color: tx.type === 'earning' || tx.type === 'bonus' ? Colors.success : Colors.ink }
              ]}>
                {tx.type === 'earning' || tx.type === 'bonus' ? '+' : '-'}{fmtUgx(tx.amount_ugx)}
              </Text>
            </View>
          ))}
        </Card>
      )}

      <View style={{ height: Spacing.xxl }} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: Colors.bg },
  content:      { padding: Spacing.md },
  balanceHero: {
    backgroundColor: Colors.navy,
    borderRadius: Radius.lg,
    padding: Spacing.xl,
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  balanceLabel:  { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.5)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: Spacing.sm },
  balanceAmount: { fontSize: 36, fontWeight: '700', color: Colors.white, fontVariant: ['tabular-nums'] },
  pendingText:   { fontSize: 13, color: Colors.sky, marginTop: 4 },
  withdrawBtn:   { marginTop: Spacing.lg, paddingHorizontal: Spacing.xl },
  withdrawForm:  { marginBottom: Spacing.sm },
  withdrawTitle: { fontSize: 16, fontWeight: '700', color: Colors.ink, marginBottom: 4 },
  withdrawSub:   { fontSize: 13, color: Colors.inkMuted, marginBottom: Spacing.md },
  amountInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.sm,
    padding: 14,
    fontSize: 18,
    fontWeight: '600',
    color: Colors.ink,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  txLeft:   { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  txInfo:   { flex: 1 },
  txDesc:   { fontSize: 14, fontWeight: '500', color: Colors.ink },
  txDate:   { fontSize: 12, color: Colors.inkSubtle, marginTop: 2 },
  txAmount: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
})
