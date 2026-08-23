import { Pool } from 'pg'

// catalog_db. No other SCS has a role that can connect to it.
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const SEED = [
  { sku: 'KB-01', name: 'Mechanical Keyboard', priceCents: 34900 },
  { sku: 'MS-02', name: 'Wireless Mouse', priceCents: 12900 },
  { sku: 'HP-03', name: 'Studio Headphones', priceCents: 89900 },
  { sku: 'MN-04', name: '27" Monitor', priceCents: 189900 },
]

let ready: Promise<void> | null = null

async function init(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      sku         text PRIMARY KEY,
      name        text NOT NULL,
      price_cents integer NOT NULL
    )
  `)
  // The feed is an append-only log owned by this SCS. It is the only
  // thing other systems are allowed to read, and they read it by polling.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_events (
      seq         bigserial PRIMARY KEY,
      type        text NOT NULL,
      sku         text NOT NULL,
      name        text NOT NULL,
      price_cents integer NOT NULL,
      at          timestamptz NOT NULL DEFAULT now()
    )
  `)

  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM products')
  if (rows[0].n !== '0') return

  for (const p of SEED) {
    await pool.query('INSERT INTO products (sku, name, price_cents) VALUES ($1, $2, $3)', [
      p.sku,
      p.name,
      p.priceCents,
    ])
    await publish(p.sku, p.name, p.priceCents)
  }
}

export async function db(): Promise<Pool> {
  ready ??= init().catch((err) => {
    ready = null
    throw err
  })
  await ready
  return pool
}

export async function publish(sku: string, name: string, priceCents: number): Promise<void> {
  await pool.query(
    `INSERT INTO product_events (type, sku, name, price_cents)
     VALUES ('ProductChanged', $1, $2, $3)`,
    [sku, name, priceCents],
  )
}

export type Product = { sku: string; name: string; price_cents: number }
