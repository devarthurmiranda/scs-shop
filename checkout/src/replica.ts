import { pool, readCursor, writeCursor } from './db.js'

const FEED = process.env.CATALOG_FEED_URL ?? 'http://catalog:3000/catalog/feed'
const INTERVAL_MS = 5000

type ProductChanged = {
  seq: number
  type: string
  sku: string
  name: string
  priceCents: number
}

// Asynchronous integration, pull style. checkout decides when to read,
// catalog never calls checkout, and a failed poll is a non-event: the
// replica simply stays as it was until the next round.
async function poll(): Promise<void> {
  const since = await readCursor('catalog')
  const res = await fetch(`${FEED}?since=${since}`)
  if (!res.ok) throw new Error(`catalog feed responded ${res.status}`)

  const body = (await res.json()) as { events: ProductChanged[]; nextSince: number }
  if (!body.events.length) return

  for (const e of body.events) {
    if (e.type !== 'ProductChanged') continue
    await pool.query(
      `INSERT INTO product_replica (sku, name, price_cents, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (sku) DO UPDATE
         SET name = EXCLUDED.name,
             price_cents = EXCLUDED.price_cents,
             updated_at = now()`,
      [e.sku, e.name, e.priceCents],
    )
  }

  await writeCursor('catalog', body.nextSince)
  console.log(`[replica] applied ${body.events.length} event(s) from catalog, cursor=${body.nextSince}`)
}

export function startReplication(): void {
  const tick = () =>
    poll().catch((err) => console.warn(`[replica] catalog unreachable, keeping local copy: ${err.message}`))
  tick()
  setInterval(tick, INTERVAL_MS)
}
