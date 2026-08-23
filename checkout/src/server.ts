import Fastify from 'fastify'
import formbody from '@fastify/formbody'
import { randomUUID } from 'node:crypto'
import { pool, init } from './db.js'
import { startReplication } from './replica.js'
import { page, money, escape } from './views.js'

const app = Fastify({ logger: false })
await app.register(formbody)

type CartRow = { sku: string; qty: number; name: string | null; price_cents: number | null; updated_at: Date | null }

// Reads only from checkout's own database. No call to catalog on the request path.
async function cart(): Promise<CartRow[]> {
  const { rows } = await pool.query<CartRow>(
    `SELECT ci.sku, ci.qty, pr.name, pr.price_cents, pr.updated_at
       FROM cart_items ci
       LEFT JOIN product_replica pr ON pr.sku = ci.sku
      ORDER BY ci.sku`,
  )
  return rows
}

const total = (rows: CartRow[]) => rows.reduce((sum, r) => sum + (r.price_cents ?? 0) * r.qty, 0)

// UI fragment owned by checkout, transcluded into catalog pages by nginx.
app.get('/checkout/fragment/minicart', async (_req, reply) => {
  const rows = await cart()
  const count = rows.reduce((n, r) => n + r.qty, 0)
  reply.type('text/html')
  return `<a href="/checkout/cart">Cart (${count}) &middot; ${money(total(rows))}</a>`
})

app.get('/checkout/cart', async (_req, reply) => {
  const rows = await cart()
  const oldest = rows.reduce<Date | null>(
    (acc, r) => (r.updated_at && (!acc || r.updated_at < acc) ? r.updated_at : acc),
    null,
  )

  const body = rows.length
    ? `<main>
    <h1>Cart</h1>
    ${rows
      .map(
        (r) => `<div class="card">
      <div class="grow">
        <div class="name">${escape(r.name ?? r.sku)}</div>
        <div class="meta">${escape(r.sku)} &middot; ${r.qty} &times; ${money(r.price_cents ?? 0)}</div>
      </div>
    </div>`,
      )
      .join('\n')}
    <div class="card"><div class="grow"><div class="name">Total</div></div><div>${money(total(rows))}</div></div>
    <form action="/checkout/orders" method="post"><button type="submit">Place order</button></form>
    <p class="stale">Names and prices come from checkout's own replica of the catalog feed${
      oldest ? `, last updated ${oldest.toISOString()}` : ''
    }. This page never calls catalog.</p>
  </main>`
    : `<main><h1>Cart</h1><p>Empty. <a href="/catalog">Browse products</a>.</p></main>`

  reply.type('text/html')
  return page('Cart', body)
})

app.post<{ Body: { sku?: string } }>('/checkout/cart/items', async (request, reply) => {
  const sku = request.body.sku
  if (sku) {
    await pool.query(
      `INSERT INTO cart_items (sku, qty) VALUES ($1, 1)
       ON CONFLICT (sku) DO UPDATE SET qty = cart_items.qty + 1`,
      [sku],
    )
  }
  return reply.code(303).header('location', '/catalog').send()
})

app.post('/checkout/orders', async (_req, reply) => {
  const rows = await cart()
  if (!rows.length) return reply.code(303).header('location', '/checkout/cart').send()

  const id = randomUUID().slice(0, 8)
  const items = rows.map((r) => ({
    sku: r.sku,
    name: r.name ?? r.sku,
    qty: r.qty,
    priceCents: r.price_cents ?? 0,
  }))

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO orders (id, total_cents) VALUES ($1, $2)', [id, total(rows)])
    // Order and event are written in one transaction, so the feed can never
    // disagree with this system's own state.
    await client.query(
      `INSERT INTO order_events (type, order_id, payload)
       VALUES ('OrderPlaced', $1, $2)`,
      [id, JSON.stringify({ orderId: id, totalCents: total(rows), items })],
    )
    await client.query('DELETE FROM cart_items')
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return reply.code(303).header('location', '/orders/').send()
})

// checkout's published feed. orders polls it.
app.get<{ Querystring: { since?: string } }>('/checkout/feed', async (request) => {
  const since = Number(request.query.since ?? 0) || 0
  const { rows } = await pool.query(
    `SELECT seq, type, order_id, payload, at
       FROM order_events
      WHERE seq > $1
      ORDER BY seq
      LIMIT 100`,
    [since],
  )

  return {
    events: rows.map((r) => ({
      seq: Number(r.seq),
      type: r.type,
      orderId: r.order_id,
      at: r.at,
      ...r.payload,
    })),
    nextSince: rows.length ? Number(rows[rows.length - 1].seq) : since,
  }
})

await init()
startReplication()
await app.listen({ host: '0.0.0.0', port: 3001 })
console.log('[checkout] listening on 3001')
