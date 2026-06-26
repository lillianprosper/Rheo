import React, { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native'
import { api } from '../../lib/api'
import { Card, StatusBadge, SectionHeader, EmptyState } from '../../components/UI'
import { Colors, Spacing, Radius } from '../../lib/tokens'

function fmtUgx(n: any) { return `UGX ${Number(n||0).toLocaleString()}` }

export default function HistoryScreen() {
  const [jobs,      setJobs]      = useState<any[]>([])
  const [total,     setTotal]     = useState(0)
  const [page,      setPage]      = useState(1)
  const [loading,   setLoading]   = useState(true)
  const [refreshing,setRefreshing]= useState(false)

  const load = useCallback(async (p = 1) => {
    try {
      const res = await api.job.history(p)
      if (p === 1) setJobs(res.data || [])
      else setJobs((prev) => [...prev, ...(res.data || [])])
      setTotal(res.meta?.total || 0)
    } catch {} finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { load(1) }, [load])

  return (
    <View style={styles.container}>
      <FlatList
        data={jobs}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Card style={styles.jobCard}>
            <View style={styles.jobHeader}>
              <Text style={styles.jobRef}>{item.job_ref}</Text>
              <StatusBadge status={item.status} />
            </View>
            <Text style={styles.address} numberOfLines={1}>{item.pickup_address}</Text>
            <Text style={styles.addressArrow}>↓</Text>
            <Text style={styles.address} numberOfLines={1}>{item.delivery_address}</Text>
            <View style={styles.jobFooter}>
              <Text style={styles.date}>{new Date(item.created_at).toLocaleDateString('en-UG')}</Text>
              <Text style={[
                styles.earning,
                { color: item.status === 'delivered' ? Colors.success : Colors.inkSubtle }
              ]}>
                {item.status === 'delivered' ? fmtUgx(item.driver_payout_ugx) : '—'}
              </Text>
            </View>
          </Card>
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); setPage(1); load(1) }}
            tintColor={Colors.navyBase}
          />
        }
        onEndReached={() => {
          if (jobs.length < total) {
            const nextPage = page + 1
            setPage(nextPage)
            load(nextPage)
          }
        }}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              icon="📋"
              title="No completed jobs yet"
              subtitle="Your delivery history will appear here"
            />
          )
        }
        ListHeaderComponent={
          <SectionHeader title={`${total} total deliveries`} />
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  list:      { padding: Spacing.md, paddingBottom: Spacing.xxl },
  jobCard:   { marginBottom: Spacing.sm },
  jobHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  jobRef:    { fontSize: 12, fontFamily: 'Courier', color: Colors.navyBase, fontWeight: '700' },
  address:   { fontSize: 13, color: Colors.ink, lineHeight: 18 },
  addressArrow: { fontSize: 11, color: Colors.inkSubtle, marginVertical: 2, marginLeft: 2 },
  jobFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  date:      { fontSize: 12, color: Colors.inkSubtle },
  earning:   { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
})
