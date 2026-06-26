// ─── Background GPS location tracking ────────────────────────────────────────
// STRIDE: Privacy — location tracking is strictly scoped to active jobs only.
// The background task is registered when a job is accepted and unregistered
// immediately on delivery, failure, or cancellation. No passive tracking.
//
// Fires every 4 seconds — optimized for boda boda speed in Kampala traffic.
// Uses expo-task-manager for background execution on both iOS and Android.

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import { api } from './api'

export const LOCATION_TASK = 'rheo-location-tracking'

// Active job ID — set before starting tracking, cleared on stop
let activeJobId: string | null = null

// ─── Define background task ───────────────────────────────────────────────────
// Must be defined at module root level — Expo requirement.
// Fires even when app is backgrounded.

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error || !data) return
  const { locations } = data as { locations: Location.LocationObject[] }
  const loc = locations[locations.length - 1]
  if (!loc || !activeJobId) return

  // Fire-and-forget — location updates are best-effort
  await api.job.sendLocation(
    activeJobId,
    loc.coords.latitude,
    loc.coords.longitude,
  )
})

// ─── Start tracking ───────────────────────────────────────────────────────────

export async function startTracking(jobId: string): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync()
  if (status !== 'granted') return false

  const bgStatus = await Location.requestBackgroundPermissionsAsync()
  if (bgStatus.status !== 'granted') return false

  activeJobId = jobId

  const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)
    .catch(() => false)

  if (!isRunning) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy:              Location.Accuracy.High,
      timeInterval:          4_000,   // 4 seconds — fast enough for live tracking
      distanceInterval:      10,      // minimum 10m movement to fire
      deferredUpdatesInterval: 4_000,
      foregroundService: {
        notificationTitle:   'Rheo — Delivery in progress',
        notificationBody:    'Your location is being shared with the customer',
        notificationColor:   '#0D1B3E',
      },
      pausesUpdatesAutomatically: false,
      activityType:          Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
    })
  }

  return true
}

// ─── Stop tracking ────────────────────────────────────────────────────────────

export async function stopTracking(): Promise<void> {
  activeJobId = null
  const isRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)
    .catch(() => false)
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK)
  }
}

// ─── Get current position ─────────────────────────────────────────────────────

export async function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    const loc = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    })
    return { lat: loc.coords.latitude, lng: loc.coords.longitude }
  } catch { return null }
}
