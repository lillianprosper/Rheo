import crypto from 'crypto'

// ─── AES-256-GCM field-level encryption ──────────────────────────────────────
// STRIDE: Information Disclosure — NIN, account numbers, 2FA secrets are
// encrypted at rest using authenticated encryption (GCM). The auth tag
// prevents silent tampering — any modification to ciphertext is detected.
//
// Format: base64( iv[12] || ciphertext || authTag[16] )
// IV is randomly generated per encryption — same plaintext → different output.
// Key must be 32 bytes (256-bit), loaded from ENCRYPTION_KEY env variable.

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12   // 96-bit IV — recommended for GCM
const TAG_LENGTH = 16  // 128-bit auth tag — GCM default

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error('ENCRYPTION_KEY environment variable is not set')
  const buf = Buffer.from(key, 'hex')
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)')
  }
  return buf
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string safe for DB storage.
 * Non-deterministic: calling twice on the same value gives different output.
 */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  // Concatenate iv + ciphertext + authTag then base64-encode
  return Buffer.concat([iv, encrypted, authTag]).toString('base64')
}

/**
 * Decrypt a base64-encoded ciphertext produced by encrypt().
 * Throws if the ciphertext has been tampered with (auth tag mismatch).
 */
export function decrypt(ciphertext: string): string {
  const key = getKey()
  const buf = Buffer.from(ciphertext, 'base64')

  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid ciphertext: too short')
  }

  const iv      = buf.subarray(0, IV_LENGTH)
  const tag     = buf.subarray(buf.length - TAG_LENGTH)
  const payload = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
  decipher.setAuthTag(tag)

  try {
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
  } catch {
    // GCM auth tag failure — ciphertext was tampered with or wrong key
    throw new Error('Decryption failed: invalid ciphertext or key')
  }
}

/**
 * Generate a cryptographically secure random token.
 * @param bytes Number of random bytes (output hex length = bytes * 2)
 * Default 32 bytes = 64-char hex string suitable for refresh tokens and OTPs.
 */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Use when comparing tokens, OTPs, or HMAC signatures.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Hash a value using SHA-256. Use for storing refresh tokens in DB
 * (store hash, compare hash — never store raw token).
 */
export function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}
