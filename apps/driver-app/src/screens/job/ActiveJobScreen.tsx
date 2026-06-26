import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Alert,
  TouchableOpacity, Linking, Platform,
} from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { useRouter } from 'expo-router'
import { api, DriverApiError } from '../../lib/api'
import { startTracking, stopTracking } from '../../lib/location'
import { Card, Button, StatusBadge, InfoRow, Divider, SectionHeader } from '../../components/UI'
import { Colors, Spacing, Radius } from '../../lib/tokens'

type JobStatus = 'assigned' | 'picked_up' | 'in_transit' | 'delivered' | 'failed'

interface ActiveJob {
  id:                  string
  jobRef:              string
  status:              JobStatus
  pickupAddress:       string
  pickupLat?:          number
  pickupLng?:          number
  pickupContactName?:  string
  pickupContactPhone?: string
  deliveryAddress:     string
  deliveryLat?:        number
  deliveryLng?:        number
  deliveryContactName?:  string
  deliveryContactPhone?: string
  description:         string
  weightKg?:           number
  fragile:             boolean
  specialInstructions?:string
  totalFareUgx:        number
  driverPayoutUgx:     number
  businessName?:       string
}

function fmtUgx(n: number) {
  return `UGX ${Number(n).toLocaleString()}`
}

function callNumber(phone?: string) {
  if (!phone) return
  Linking.openURL(`tel:${phone}`)
}

function openMaps(lat?: number, lng?: number, address?: string) {
  if (!lat || !lng) return
  const scheme = Platform.OS === 'ios' ? 'maps:' : 'geo:'
  const url = Platform.OS === 'ios'
    ? `maps:?q=${address}&ll=${lat},${lng}`
    : `geo:${lat},${lng}?q=${address}`
  Linking.openURL(url)
}

// ─── Status flow: assigned → picked_up → in_transit → delivered ──────────────
const STATUS_NEXT: Partial<Record<JobStatus, { label: string; next: string }>> = {
  assigned:   { label: 'Mark as Picked Up',  next: 'picked_up' },
  picked_up:  { label: 'Start Delivery',     next: 'in_transit' },
  in_transit: { label: 'Mark as Delivered',  next: 'delivered' },
}

export default function ActiveJobScreen() {
  const router        = useRouter()
  const [job,     setJob]     = useState<ActiveJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting,  setActing]  = useState(false)
  const trackingRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const raw = await api.job.active()
      setJob(mapJob(raw))
    } catch {
      // No active job
      router.replace('/(tabs)/board')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { load() }, [load])

  // Start GPS tracking when job loads and is in active state
  useEffect(() => {
    if (!job || trackingRef.current) return
    if (['assigned', 'picked_up', 'in_transit'].includes(job.status)) {
      startTracking(job.id).then((ok) => {
        if (ok) trackingRef.current = true
      })
    }
  }, [job])

  async function handleStatusUpdate() {
    if (!job) return
    const next = STATUS_NEXT[job.status]
    if (!next) return

    // Delivered requires POD photo
    if (next.next === 'delivered') {
      await handleDeliver()
      return
    }

    setActing(true)
    try {
      await api.job.setStatus(job.id, next.next)
      await load()
    } catch (err) {
      Alert.alert('Error', err instanceof DriverApiError ? err.message : 'Failed to update status')
    } finally {
      setActing(false)
    }
  }

  async function handleDeliver() {
    Alert.alert(
      'Proof of delivery',
      'Take a photo to confirm delivery',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open camera',
          onPress: async () => {
            const { status } = await ImagePicker.requestCameraPermissionsAsync()
            if (status !== 'granted') {
              Alert.alert('Permission needed', 'Camera access is required for proof of delivery')
              return
            }
            const result = await ImagePicker.launchCameraAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.7,
              allowsEditing: false,
            })
            if (result.canceled || !result.assets[0]) return

            setActing(true)
            try {
              await api.job.submitPod(job!.id, result.assets[0].uri)
              await api.job.setStatus(job!.id, 'delivered')
              await stopTracking()
              trackingRef.current = false
              Alert.alert('Delivered! 🎉', `You earned ${fmtUgx(job!.driverPayoutUgx)}. Funds added to your wallet.`, [
                { text: 'View wallet', onPress: () => router.replace('/(tabs)/wallet') },
                { text: 'Back to board', onPress: () => router.replace('/(tabs)/board') },
              ])
            } catch (err) {
              Alert.alert('Error', err instanceof DriverApiError ? err.message : 'Failed to submit delivery')
            } finally {
              setActing(false)
            }
          },
        },
      ]
    )
  }

  async function handleReport() {
    Alert.alert(
      'Report issue',
      'What happened with this delivery?',
      [
        { text: 'Customer not available', onPress: () => reportFailed('Customer not available') },
        { text: 'Wrong address',           onPress: () => reportFailed('Wrong address provided') },
        { text: 'Package issue',           onPress: () => reportFailed('Package issue') },
        { text: 'Cancel', style: 'cancel' },
      ]
    )
  }

  async function reportFailed(reason: string) {
    setActing(true)
    try {
      await api.job.setStatus(job!.id, 'failed', reason)
      await stopTracking()
      trackingRef.current = false
      router.replace('/(tabs)/board')
    } catch (err) {
      Alert.alert('Error', err instanceof DriverApiError ? err.message : 'Failed')
    } finally {
      setActing(false)
    }
  }

  if (loading || !job) {
    return (
      <View style={[styles.container, { justifyContent:'center', alignItems:'center' }]}>
        <Text style={{ color: Colors.inkMuted }}>Loading your job…</Text>
      </View>
    )
  }

  const nextAction = STATUS_NEXT[job.status]

  return (
    <View style={styles.container}>
      {/* Active job header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerRef}>{job.jobRef}</Text>
          <StatusBadge status={job.status} />
        </View>
        <Text style={styles.headerEarning}>{fmtUgx(job.driverPayoutUgx)}</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        {/* Package info */}
        <SectionHeader title="Package" />
        <Card>
          <Text style={styles.description}>{job.description}</Text>
          {job.weightKg && <InfoRow label="Weight" value={`${job.weightKg} kg`} />}
          {job.fragile   && <InfoRow label="Handling" value="⚠ Fragile — handle with care" />}
          {job.specialInstructions && <InfoRow label="Instructions" value={job.specialInstructions} />}
        </Card>

        {/* Pickup */}
        <SectionHeader title="Pickup" />
        <Card>
          <TouchableOpacity onPress={() => openMaps(job.pickupLat, job.pickupLng, job.pickupAddress)}>
            <Text style={styles.addressLink}>{job.pickupAddress}</Text>
            <Text style={styles.mapHint}>Tap to open in maps →</Text>
          </TouchableOpacity>
          {job.pickupContactName && (
            <>
              <Divider />
              <InfoRow label="Contact" value={job.pickupContactName} />
              {job.pickupContactPhone && (
                <TouchableOpacity onPress={() => callNumber(job.pickupContactPhone)} style={styles.callBtn}>
                  <Text style={styles.callBtnText}>📞 Call {job.pickupContactPhone}</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </Card>

        {/* Delivery */}
        <SectionHeader title="Delivery" />
        <Card>
          <TouchableOpacity onPress={() => openMaps(job.deliveryLat, job.deliveryLng, job.deliveryAddress)}>
            <Text style={styles.addressLink}>{job.deliveryAddress}</Text>
            <Text style={styles.mapHint}>Tap to open in maps →</Text>
          </TouchableOpacity>
          {job.deliveryContactName && (
            <>
              <Divider />
              <InfoRow label="Contact" value={job.deliveryContactName} />
              {job.deliveryContactPhone && (
                <TouchableOpacity onPress={() => callNumber(job.deliveryContactPhone)} style={styles.callBtn}>
                  <Text style={styles.callBtnText}>📞 Call {job.deliveryContactPhone}</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </Card>

        {/* Earnings */}
        <SectionHeader title="Earnings" />
        <Card>
          <InfoRow label="Job fare"      value={fmtUgx(job.totalFareUgx)} />
          <InfoRow label="Your payout"   value={fmtUgx(job.driverPayoutUgx)} />
        </Card>

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>

      {/* Bottom action bar */}
      <View style={styles.actionBar}>
        {nextAction && (
          <Button
            label={nextAction.label}
            onPress={handleStatusUpdate}
            variant="yellow"
            loading={acting}
            style={styles.primaryAction}
          />
        )}
        <TouchableOpacity onPress={handleReport} style={styles.reportBtn}>
          <Text style={styles.reportBtnText}>Report an issue</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function mapJob(raw: any): ActiveJob {
  return {
    id:                  raw.id,
    jobRef:              raw.job_ref,
    status:              raw.status,
    pickupAddress:       raw.pickup_address,
    pickupLat:           raw.pickup_lat,
    pickupLng:           raw.pickup_lng,
    pickupContactName:   raw.pickup_contact_name,
    pickupContactPhone:  raw.pickup_contact_phone,
    deliveryAddress:     raw.delivery_address,
    deliveryLat:         raw.delivery_lat,
    deliveryLng:         raw.delivery_lng,
    deliveryContactName:  raw.delivery_contact_name,
    deliveryContactPhone: raw.delivery_contact_phone,
    description:         raw.description,
    weightKg:            raw.weight_kg,
    fragile:             raw.fragile,
    specialInstructions: raw.special_instructions,
    totalFareUgx:        parseFloat(raw.total_fare_ugx),
    driverPayoutUgx:     parseFloat(raw.driver_payout_ugx || 0),
    businessName:        raw.business_name,
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    backgroundColor: Colors.navy,
    paddingTop: 60,
    paddingBottom: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  headerRef:     { fontSize: 12, fontFamily: 'Courier', color: Colors.sky, marginBottom: 4 },
  headerEarning: { fontSize: 24, fontWeight: '700', color: Colors.yellow },
  scroll:        { flex: 1 },
  scrollContent: { padding: Spacing.md },
  description:   { fontSize: 15, color: Colors.ink, lineHeight: 22, marginBottom: Spacing.sm },
  addressLink:   { fontSize: 15, fontWeight: '600', color: Colors.navyBase, lineHeight: 22 },
  mapHint:       { fontSize: 12, color: Colors.sky, marginTop: 2 },
  callBtn: {
    backgroundColor: Colors.navyPale,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    marginTop: Spacing.sm,
    alignItems: 'center',
  },
  callBtnText: { fontSize: 14, fontWeight: '600', color: Colors.navyBase },
  actionBar: {
    backgroundColor: Colors.white,
    padding: Spacing.md,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: Spacing.sm,
  },
  primaryAction: { width: '100%' },
  reportBtn: { alignItems: 'center', padding: Spacing.sm },
  reportBtnText: { fontSize: 14, color: Colors.inkMuted, fontWeight: '500' },
})
