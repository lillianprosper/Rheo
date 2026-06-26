import React, { useEffect, useState, useCallback } from 'react'
import {
  View, Text, FlatList, StyleSheet, RefreshControl,
  TouchableOpacity, Alert,
} from 'react-native'
import { useRouter } from 'expo-router'
import { io, Socket } from 'socket.io-client'
import { api, getTokens, DriverApiError } from '../../lib/api'
import { useAuth } from '../../store/auth'
import { Card, Button, StatusBadge, EmptyState, SectionHeader } from '../../components/UI'
import { Colors, Spacing, Radius } from '../../lib/tokens'

interface Job {
  id:             string
  jobRef:         string
  pickupAddress:  string
  deliveryAddress:string
  totalFareUgx:   number
  weightKg?:      number
  fragile:        boolean
  vehicleType?:   string
  description:    string
  status:         string
  createdAt:      string
}

function fmtUgx(n: number) {
  return `UGX ${Number(n).toLocaleString()}`
}

function JobCard({ job, onAccept, accepting }: {
  job:       Job
  onAccept:  (id: string) => void
  accepting: boolean
}) {
  return (
    <Card accent style={styles.jobCard}>
      {/* Header */}
      <View style={styles.jobHeader}>
        <Text style={styles.jobRef}>{job.jobRef}</Text>
        <Text style={styles.fare}>{fmtUgx(job.totalFareUgx)}</Text>
      </View>

      {/* Route */}
      <View style={styles.route}>
        <View style={styles.routeRow}>
          <View style={[styles.routeDot, { backgroundColor: Colors.navyBase }]} />
          <View style={styles.routeText}>
            <Text style={styles.routeLabel}>PICKUP</Text>
            <Text style={styles.routeAddress} numberOfLines={2}>{job.pickupAddress}</Text>
          </View>
        </View>
        <View style={styles.routeLine} />
        <View style={styles.routeRow}>
          <View style={[styles.routeDot, { backgroundColor: Colors.yellow }]} />
          <View style={styles.routeText}>
            <Text style={styles.routeLabel}>DELIVERY</Text>
            <Text style={styles.routeAddress} numberOfLines={2}>{job.deliveryAddress}</Text>
          </View>
        </View>
      </View>

      {/* Tags */}
      <View style={styles.tags}>
        {job.weightKg && (
          <View style={styles.tag}>
            <Text style={styles.tagText}>⚖ {job.weightKg} kg</Text>
          </View>
        )}
        {job.fragile && (
          <View style={[styles.tag, { backgroundColor: Colors.warningBg }]}>
            <Text style={[styles.tagText, { color: Colors.warning }]}>⚠ Fragile</Text>
          </View>
        )}
        {job.vehicleType && (
          <View style={styles.tag}>
            <Text style={styles.tagText}>🚴 {job.vehicleType}</Text>
          </View>
        )}
      </View>

      <Button
        label="Accept job"
        onPress={() => onAccept(job.id)}
        variant="yellow"
        loading={accepting}
        style={styles.acceptBtn}
      />
    </Card>
  )
}

export default function BoardScreen() {
  const router          = useRouter()
  const { driver }      = useAuth()
  const [jobs,      setJobs]      = useState<Job[]>([])
  const [loading,   setLoading]   = useState(true)
  const [refreshing,setRefreshing]= useState(false)
  const [accepting, setAccepting] = useState<string | null>(null)

  const loadBoard = useCallback(async () => {
    try {
      const raw = await api.board.list()
      setJobs(raw.map(mapJob))
    } catch {} finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { loadBoard() }, [loadBoard])

  // WebSocket — live board updates
  useEffect(() => {
    let socket: Socket
    const connect = async () => {
      const { access } = await getTokens()
      if (!access) return
      socket = io(process.env.EXPO_PUBLIC_WS_URL || 'http://localhost:4000', {
        auth:       { token: `Bearer ${access}` },
        transports: ['websocket'],
      })
      socket.on('job:new',       () => loadBoard())
      socket.on('job:cancelled', () => loadBoard())
    }
    connect()
    return () => { socket?.disconnect() }
  }, [loadBoard])

  async function handleAccept(jobId: string) {
    setAccepting(jobId)
    try {
      await api.board.accept(jobId)
      router.replace('/(tabs)/job')
    } catch (err) {
      Alert.alert(
        'Could not accept',
        err instanceof DriverApiError ? err.message : 'Job may have been taken. Refreshing board.',
        [{ text: 'OK' }]
      )
      loadBoard()
    } finally {
      setAccepting(null)
    }
  }

  // Check if driver has active job already
  useEffect(() => {
    api.job.active().then(() => {
      router.replace('/(tabs)/job')
    }).catch(() => {})
  }, [])

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.greeting}>
            Hey {driver?.firstName} 👋
          </Text>
          <Text style={styles.subGreeting}>
            {jobs.length > 0 ? `${jobs.length} job${jobs.length!==1?'s':''} available` : 'No jobs right now'}
          </Text>
        </View>
        <View style={[
          styles.onlineDot,
          { backgroundColor: driver?.isOnline ? Colors.success : Colors.inkSubtle }
        ]} />
      </View>

      {loading ? (
        <EmptyState icon="📦" title="Loading jobs…" />
      ) : (
        <FlatList
          data={jobs}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <JobCard
              job={item}
              onAccept={handleAccept}
              accepting={accepting === item.id}
            />
          )}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); loadBoard() }}
              tintColor={Colors.navyBase}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="🕐"
              title="No jobs available"
              subtitle="Pull down to refresh. New jobs appear here instantly."
            />
          }
        />
      )}
    </View>
  )
}

function mapJob(raw: any): Job {
  return {
    id:              raw.id,
    jobRef:          raw.job_ref,
    pickupAddress:   raw.pickup_address,
    deliveryAddress: raw.delivery_address,
    totalFareUgx:    parseFloat(raw.total_fare_ugx),
    weightKg:        raw.weight_kg,
    fragile:         raw.fragile,
    vehicleType:     raw.vehicle_type,
    description:     raw.description,
    status:          raw.status,
    createdAt:       raw.created_at,
  }
}

const styles = StyleSheet.create({
  container:  { flex:1, backgroundColor: Colors.bg },
  topBar: {
    backgroundColor: Colors.navy,
    paddingTop: 60,
    paddingBottom: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  greeting:    { fontSize: 20, fontWeight: '700', color: Colors.white },
  subGreeting: { fontSize: 13, color: 'rgba(255,255,255,0.55)', marginTop: 2 },
  onlineDot:   { width: 12, height: 12, borderRadius: 6 },
  list:        { padding: Spacing.md, paddingBottom: Spacing.xxl },
  jobCard:     { marginBottom: Spacing.sm },
  jobHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  jobRef:  { fontSize: 12, fontFamily: 'Courier', color: Colors.navyBase, fontWeight: '700' },
  fare:    { fontSize: 20, fontWeight: '700', color: Colors.ink },
  route:   { marginBottom: Spacing.md },
  routeRow:{ flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  routeDot:{ width: 10, height: 10, borderRadius: 5, marginTop: 4, flexShrink: 0 },
  routeLine:{ width: 1, height: 16, backgroundColor: Colors.border, marginLeft: 4.5, marginVertical: 2 },
  routeText:{ flex: 1 },
  routeLabel:{ fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: Colors.inkSubtle },
  routeAddress:{ fontSize: 14, color: Colors.ink, lineHeight: 20, marginTop: 1 },
  tags:{ flexDirection:'row', flexWrap:'wrap', gap: 6, marginBottom: Spacing.md },
  tag:{ backgroundColor: Colors.navyPale, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.full },
  tagText:{ fontSize: 11, fontWeight: '600', color: Colors.navyMid },
  acceptBtn:{ marginTop: Spacing.xs },
})
