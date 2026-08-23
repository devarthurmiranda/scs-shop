import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// The published contract of this SCS: an ordered, append-only, pull-based feed.
// No broker. Consumers keep their own cursor and poll whenever they like.
export async function GET(request: Request) {
  const since = Number(new URL(request.url).searchParams.get('since') ?? 0) || 0
  const pool = await db()

  const { rows } = await pool.query(
    `SELECT seq, type, sku, name, price_cents, at
       FROM product_events
      WHERE seq > $1
      ORDER BY seq
      LIMIT 100`,
    [since],
  )

  return Response.json({
    events: rows.map((r) => ({
      seq: Number(r.seq),
      type: r.type,
      sku: r.sku,
      name: r.name,
      priceCents: r.price_cents,
      at: r.at,
    })),
    nextSince: rows.length ? Number(rows[rows.length - 1].seq) : since,
  })
}
