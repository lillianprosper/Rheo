import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import path from 'path'
import { logger } from '../utils/logger'
import { AppError } from '../utils/errors'

// ─── S3 client ────────────────────────────────────────────────────────────────
// STRIDE: Information Disclosure — KYC documents and POD photos must never
// be publicly accessible. All objects are uploaded private-by-default.
// Access is granted only via time-limited presigned URLs (15 min).
// af-south-1 (Cape Town) gives lowest latency from Uganda vs us-east-1.

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'af-south-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
})

const BUCKET = process.env.AWS_S3_BUCKET || 'rheo-documents'

// ─── Allowlists ───────────────────────────────────────────────────────────────
// STRIDE: Tampering — only permit known safe MIME types.
// Reject executables, scripts, and anything not needed for logistics KYC.

const ALLOWED_DOCUMENT_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'application/pdf',
])

const ALLOWED_PHOTO_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
])

// Max sizes
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024  // 5MB — KYC docs, insurance
const MAX_PHOTO_BYTES    = 2 * 1024 * 1024  // 2MB — POD photos, avatars

// ─── Key namespacing ──────────────────────────────────────────────────────────
// Predictable key structure prevents enumeration and makes IAM policies
// easier to scope per entity type.
//
// drivers/{driverId}/docs/{uuid}.{ext}
// drivers/{driverId}/avatar/{uuid}.{ext}
// businesses/{businessId}/kyc/{uuid}.{ext}
// jobs/{jobId}/pod/{uuid}.{ext}

export type StorageFolder =
  | 'drivers/docs'
  | 'drivers/avatars'
  | 'businesses/kyc'
  | 'jobs/pod'
  | 'staff/avatars'

export interface UploadResult {
  key: string          // S3 object key — store this in DB, not the URL
  url: string          // Presigned URL valid for 15 minutes
  size: number
  mimeType: string
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Upload a file buffer to S3.
 * Validates MIME type and size before sending.
 * Returns the S3 key (store in DB) and a short-lived presigned URL.
 */
export async function uploadFile(opts: {
  buffer:   Buffer
  mimeType: string
  folder:   StorageFolder
  entityId: string        // driverId, businessId, jobId — used in key path
  originalName?: string
}): Promise<UploadResult> {
  const { buffer, mimeType, folder, entityId, originalName } = opts

  // Validate MIME type
  const isPhoto    = folder.includes('avatar') || folder.includes('pod')
  const allowedSet = isPhoto ? ALLOWED_PHOTO_TYPES : ALLOWED_DOCUMENT_TYPES
  if (!allowedSet.has(mimeType)) {
    throw new AppError(
      `File type ${mimeType} is not allowed. Accepted: ${[...allowedSet].join(', ')}`,
      422,
      'INVALID_FILE_TYPE'
    )
  }

  // Validate size
  const maxBytes = isPhoto ? MAX_PHOTO_BYTES : MAX_DOCUMENT_BYTES
  if (buffer.length > maxBytes) {
    const maxMB = maxBytes / (1024 * 1024)
    throw new AppError(
      `File too large. Maximum size is ${maxMB}MB`,
      422,
      'FILE_TOO_LARGE'
    )
  }

  // Build key — uuid prevents enumeration, ext preserves MIME hint
  const ext = extensionFromMime(mimeType)
  const key = `${folder}/${entityId}/${randomUUID()}${ext}`

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType,
      // Never public — access only via presigned URL
      ACL:         undefined,
      Metadata: {
        originalName: originalName || '',
        uploadedAt:   new Date().toISOString(),
      },
    }))
  } catch (err: any) {
    logger.error('S3 upload failed', { key, error: err.message })
    throw new AppError('File upload failed. Please try again.', 502, 'UPLOAD_FAILED')
  }

  // Return a short-lived presigned URL for immediate use (e.g. showing preview)
  const url = await getPresignedUrl(key)

  logger.info('File uploaded to S3', { key, size: buffer.length, mimeType })

  return { key, url, size: buffer.length, mimeType }
}

// ─── Presigned URL ────────────────────────────────────────────────────────────

/**
 * Generate a time-limited presigned GET URL for a private S3 object.
 * Default expiry: 15 minutes. Use shorter for sensitive KYC docs.
 * Store the S3 key in the DB — generate fresh URLs on demand.
 */
export async function getPresignedUrl(
  key: string,
  expiresInSeconds = 900  // 15 minutes
): Promise<string> {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key })
    return await getSignedUrl(s3, command, { expiresIn: expiresInSeconds })
  } catch (err: any) {
    logger.error('Failed to generate presigned URL', { key, error: err.message })
    throw new AppError('Could not generate file access URL', 502, 'PRESIGN_FAILED')
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Permanently delete an object from S3.
 * Call when a driver replaces a document or an account is deleted.
 * Non-throwing — logs error but does not surface to caller.
 */
export async function deleteFile(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
    logger.info('File deleted from S3', { key })
  } catch (err: any) {
    // Non-fatal — orphaned S3 objects are not a user-facing problem
    logger.error('S3 delete failed', { key, error: err.message })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg':       '.jpg',
    'image/jpg':        '.jpg',
    'image/png':        '.png',
    'image/webp':       '.webp',
    'application/pdf':  '.pdf',
  }
  return map[mime] || ''
}
