import { Pool, PoolClient, QueryResultRow } from 'pg'
import { logger } from '../utils/logger'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: parseInt(process.env.DATABASE_POOL_MIN || '2'),
  max: parseInt(process.env.DATABASE_POOL_MAX || '20'),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: true }
    : false,
})

pool.on('connect', () => logger.debug('DB pool: new connection established'))
pool.on('error', (err) => logger.error('DB pool: idle client error', { error: err.message }))

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const start = Date.now()
  const result = await pool.query<T>(text, params as unknown[])
  const duration = Date.now() - start
  if (duration > 1000) {
    logger.warn('Slow query detected', { duration, text: text.slice(0, 120) })
  }
  return result.rows
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function setRLSContext(client: PoolClient, businessId: string): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_business_id', $1, true)`,
    [businessId]
  )
}
