import React, { useState, useCallback } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Switch,
  Alert, TouchableOpacity,
} from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { useAuth } from '../../store/auth'
import { api, DriverApiError } from '../../lib/api'
import { Card, Button, StatusBadge, SectionHeader, InfoRow, EmptyState } from '../../components/UI'
import { Colors, Spacing, Radius } from '../../lib/tokens'

const DOC_TYPES = [
  { key: 'national_id_front', label: 'National ID (Front)' },
  { key: 'national_id_back',  label: 'National ID (Back)' },
  { key: 'drivers_license',   label: "Driver's License" },
  { key: 'vehicle_log_book',  label: 'Vehicle Log Book' },
  { key: 'insurance',         label: 'Insurance Certificate' },
  { key: 'passport_photo',    label: 'Passport Photo' },
]

export default function ProfileScreen() {
  const { driver, logout, refresh } = useAuth()
  const [isOnline,   setIsOnline]   = useState(driver?.isOnline ?? false)
  const [toggling,   setToggling]   = useState(false)
  const [uploading,  setUploading]  = useState<string | null>(null)

  async function handleToggleOnline(value: boolean) {
    setToggling(true)
    try {
      await api.driver.setOnline(value)
      setIsOnline(value)
      await refresh()
    } catch {
      Alert.alert('Error', 'Failed to update status')
    } finally {
      setToggling(false)
    }
  }

  async function handleUploadDoc(docType: string, label: string) {
    Alert.alert(
      `Upload ${label}`,
      'Choose how to add this document',
      [
        {
          text: 'Take photo',
          onPress: async () => {
            const { status } = await ImagePicker.requestCameraPermissionsAsync()
            if (status !== 'granted') {
              Alert.alert('Permission needed', 'Camera access required to upload documents')
              return
            }
            const result = await ImagePicker.launchCameraAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.8,
            })
            if (!result.canceled) await uploadDoc(docType, result.assets[0].uri)
          },
        },
        {
          text: 'Choose from gallery',
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
            if (status !== 'granted') {
              Alert.alert('Permission needed', 'Gallery access required')
              return
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.8,
            })
            if (!result.canceled) await uploadDoc(docType, result.assets[0].uri)
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    )
  }

  async function uploadDoc(docType: string, uri: string) {
    setUploading(docType)
    try {
      const formData = new FormData()
      formData.append('file', { uri, type: 'image/jpeg', name: `${docType}.jpg` } as any)
      formData.append('docType', docType)
      await api.driver.uploadDoc(formData)
      Alert.alert('Uploaded! ✅', 'Your document has been submitted for review.')
      await refresh()
    } catch (err) {
      Alert.alert('Upload failed', err instanceof DriverApiError ? err.message : 'Please try again')
    } finally {
      setUploading(null)
    }
  }

  async function handleLogout() {
    Alert.alert(
      'Sign out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => logout() },
      ]
    )
  }

  if (!driver) return <EmptyState icon="👤" title="Loading profile…" />

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Profile header */}
      <View style={styles.profileHeader}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {driver.firstName[0]}{driver.lastName[0]}
          </Text>
        </View>
        <Text style={styles.name}>{driver.firstName} {driver.lastName}</Text>
        <Text style={styles.phone}>{driver.phone}</Text>
        <View style={styles.badgeRow}>
          <StatusBadge status={driver.status} />
          <StatusBadge status={driver.kycStatus} />
        </View>
      </View>

      {/* Online toggle */}
      <Card accent>
        <View style={styles.onlineRow}>
          <View style={styles.onlineInfo}>
            <View style={[styles.onlineDot, { backgroundColor: isOnline ? Colors.success : Colors.inkSubtle }]} />
            <View>
              <Text style={styles.onlineLabel}>Available for jobs</Text>
              <Text style={styles.onlineSub}>{isOnline ? 'You are visible to dispatchers' : 'You are offline'}</Text>
            </View>
          </View>
          <Switch
            value={isOnline}
            onValueChange={handleToggleOnline}
            disabled={toggling}
            trackColor={{ false: Colors.border, true: Colors.success }}
            thumbColor={Colors.white}
          />
        </View>
      </Card>

      {/* Vehicle */}
      <SectionHeader title="Vehicle" />
      <Card>
        <InfoRow label="Type"       value={driver.vehicleType || '—'} />
        <InfoRow label="Plate"      value={driver.plateNumber || '—'} mono />
      </Card>

      {/* KYC documents */}
      <SectionHeader title="KYC documents" />
      <Card>
        {driver.kycStatus === 'approved' ? (
          <View style={styles.kycApproved}>
            <Text style={styles.kycApprovedIcon}>✅</Text>
            <Text style={styles.kycApprovedText}>Your documents are verified</Text>
          </View>
        ) : (
          <>
            {driver.kycStatus === 'pending' && (
              <View style={styles.kycPendingBanner}>
                <Text style={styles.kycPendingText}>⏳ Documents under review — we'll notify you within 24 hours</Text>
              </View>
            )}
            {driver.kycStatus !== 'approved' && (
              <View style={styles.docList}>
                {DOC_TYPES.map((doc) => (
                  <TouchableOpacity
                    key={doc.key}
                    style={styles.docItem}
                    onPress={() => handleUploadDoc(doc.key, doc.label)}
                    disabled={uploading === doc.key}
                  >
                    <Text style={styles.docLabel}>{doc.label}</Text>
                    <Text style={styles.docAction}>
                      {uploading === doc.key ? 'Uploading…' : 'Upload →'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}
      </Card>

      {/* History summary */}
      <SectionHeader title="Account" />
      <Card>
        <InfoRow label="Driver ID"   value={driver.id.slice(0,8).toUpperCase()} mono />
        <InfoRow label="KYC status"  value={driver.kycStatus.replace(/_/g,' ')} />
      </Card>

      {/* Logout */}
      <Button
        label="Sign out"
        onPress={handleLogout}
        variant="ghost"
        style={styles.logoutBtn}
      />

      <View style={{ height: Spacing.xxl }} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content:   { padding: Spacing.md },
  profileHeader: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.lg,
    backgroundColor: Colors.navy,
    borderRadius: Radius.lg,
    marginBottom: Spacing.md,
  },
  avatar: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.navyMid,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: Colors.sky,
    marginBottom: Spacing.sm,
  },
  avatarText:  { fontSize: 24, fontWeight: '700', color: Colors.white },
  name:        { fontSize: 20, fontWeight: '700', color: Colors.white, marginBottom: 4 },
  phone:       { fontSize: 14, color: 'rgba(255,255,255,0.55)', marginBottom: Spacing.sm },
  badgeRow:    { flexDirection: 'row', gap: Spacing.sm },
  onlineRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  onlineInfo:  { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  onlineDot:   { width: 10, height: 10, borderRadius: 5 },
  onlineLabel: { fontSize: 15, fontWeight: '600', color: Colors.ink },
  onlineSub:   { fontSize: 12, color: Colors.inkMuted, marginTop: 2 },
  kycApproved: { alignItems: 'center', paddingVertical: Spacing.md },
  kycApprovedIcon: { fontSize: 32, marginBottom: Spacing.sm },
  kycApprovedText: { fontSize: 15, fontWeight: '600', color: Colors.success },
  kycPendingBanner: {
    backgroundColor: Colors.yellowPale,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.yellow,
  },
  kycPendingText: { fontSize: 13, color: '#92400E', lineHeight: 18 },
  docList: { gap: 2 },
  docItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  docLabel:  { fontSize: 14, color: Colors.ink },
  docAction: { fontSize: 13, fontWeight: '600', color: Colors.navyBase },
  logoutBtn: { marginTop: Spacing.md, borderColor: Colors.dangerBg },
})
