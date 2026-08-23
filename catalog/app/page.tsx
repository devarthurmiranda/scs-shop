import { db, type Product } from '@/lib/db'

export const dynamic = 'force-dynamic'

const money = (cents: number) => `$ ${(cents / 100).toFixed(2)}`

export default async function CatalogPage() {
  const pool = await db()
  const { rows } = await pool.query<Product>('SELECT sku, name, price_cents FROM products ORDER BY sku')

  return (
    <main>
      <h1>Products</h1>

      {rows.map((p) => (
        <div className="card" key={p.sku}>
          <div className="grow">
            <div className="name">{p.name}</div>
            <div className="meta">
              {p.sku} · {money(p.price_cents)}
            </div>
          </div>

          {/* Plain link-style integration: a form POST straight into the
              checkout SCS. No API client, no shared types, no RPC. */}
          <form action="/checkout/cart/items" method="post">
            <input type="hidden" name="sku" value={p.sku} />
            <button type="submit">Add to cart</button>
          </form>

          {/* Changing the price here appends to the catalog feed.
              checkout picks it up within a few seconds, by polling. */}
          <form action="/catalog/admin/bump" method="post">
            <input type="hidden" name="sku" value={p.sku} />
            <button type="submit" className="ghost">
              Raise price
            </button>
          </form>
        </div>
      ))}
    </main>
  )
}
