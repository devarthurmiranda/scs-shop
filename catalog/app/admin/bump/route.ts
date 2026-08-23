import { db, publish, type Product } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const form = await request.formData()
  const sku = String(form.get('sku') ?? '')
  const pool = await db()

  const { rows } = await pool.query<Product>(
    `UPDATE products
        SET price_cents = price_cents + 1000
      WHERE sku = $1
      RETURNING sku, name, price_cents`,
    [sku],
  )

  if (rows.length) await publish(rows[0].sku, rows[0].name, rows[0].price_cents)

  return new Response(null, { status: 303, headers: { Location: '/catalog' } })
}
