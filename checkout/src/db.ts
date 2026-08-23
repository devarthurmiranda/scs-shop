import pg from 'pg'

const { Pool } = pg

// checkout_db. Separate database, separate role. checkout cannot read
// catalog's tables even if someone wanted it to.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export async function init(): Promise<void> {
  // Local copy of the product data this SCS needs, fed by the catalog feed.
  // This is what makes checkout survive catalog being down.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_replica (
      sku         text PRIMARY KEY,
      name        text NOT NULL,
      price_cents integer NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_cursor (
      feed text PRIMARY KEY,
      seq  bigint NOT NULL
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      sku text PRIMARY KEY,
      qty integer NOT NULL
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id          text PRIMARY KEY,
      placed_at   timestamptz NOT NULL DEFAULT now(),
      total_cents integer NOT NULL
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_events (
      seq      bigserial PRIMARY KEY,
      type     text NOT NULL,
      order_id text NOT NULL,
      payload  jsonb NOT NULL,
      at       timestamptz NOT NULL DEFAULT now()
    )
  `)
}

export async function readCursor(feed: string): Promise<number> {
  const { rows } = await pool.query<{ seq: string }>('SELECT seq FROM feed_cursor WHERE feed = $1', [feed])
  return rows.length ? Number(rows[0].seq) : 0
}

export async function writeCursor(feed: string, seq: number): Promise<void> {
  await pool.query(
    `INSERT INTO feed_cursor (feed, seq) VALUES ($1, $2)
     ON CONFLICT (feed) DO UPDATE SET seq = EXCLUDED.seq`,
    [feed, seq],
  )
}
