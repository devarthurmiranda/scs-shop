# Sharing data between systems

Two systems need the same fact. Only one of them owns it. This document explains
how the other one gets it in this repository, and why the obvious alternative is
the thing SCS exists to avoid.

Worked example throughout: **the price of a product**. `catalog` owns it.
`checkout` needs it to price a cart. Click **Raise price** on the catalog page
and watch it reach the cart about five seconds later.

## The rule

> A system never calls another system while serving a request.

Everything below follows from that one line. If checkout has to ask catalog for a
price in order to render the cart, then catalog's uptime becomes checkout's
uptime, catalog's latency becomes checkout's latency, and catalog's deploy is a
risk to checkout's revenue. Three systems chained that way multiply, they do not
average.

So checkout does not ask. It already knows, because it keeps its own copy.

## The mechanism, in four steps

### 1. The owner appends a fact to a log

When a price changes, catalog updates its own table and appends an event to an
append-only table in the same database.

`catalog/app/admin/bump/route.ts:11`

```ts
const { rows } = await pool.query<Product>(
  `UPDATE products
      SET price_cents = price_cents + 1000
    WHERE sku = $1
    RETURNING sku, name, price_cents`,
  [sku],
)

if (rows.length) await publish(rows[0].sku, rows[0].name, rows[0].price_cents)
```

`catalog/lib/db.ts:58`

```ts
export async function publish(sku: string, name: string, priceCents: number): Promise<void> {
  await pool.query(
    `INSERT INTO product_events (type, sku, name, price_cents)
     VALUES ('ProductChanged', $1, $2, $3)`,
    [sku, name, priceCents],
  )
}
```

`product_events` has a `bigserial` primary key. That sequence is the entire
ordering guarantee: monotonic, gapless enough to compare, and free.

### 2. The owner exposes the log as a feed

`catalog/app/feed/route.ts`

```ts
export async function GET(request: Request) {
  const since = Number(new URL(request.url).searchParams.get('since') ?? 0) || 0
  // ... WHERE seq > $1 ORDER BY seq LIMIT 100
  return Response.json({ events, nextSince })
}
```

That is the whole published contract of the catalog system. Not its tables, not
its ORM models, not a client library. A URL that returns ordered JSON:

```sh
curl 'http://localhost:8080/catalog/feed?since=0'
```

```json
{
  "events": [
    {"seq": 1, "type": "ProductChanged", "sku": "KB-01", "name": "Mechanical Keyboard", "priceCents": 34900}
  ],
  "nextSince": 1
}
```

Two properties matter more than the format:

- **It is pull, not push.** Catalog does not know who reads it, does not hold a
  subscriber list, and cannot be slowed down by a slow consumer.
- **It is replayable.** `since=0` returns everything from the beginning. A new
  consumer bootstraps itself with no migration, no export, and no meeting.

### 3. The consumer polls and keeps its own copy

`checkout/src/replica.ts`

```ts
const FEED = process.env.CATALOG_FEED_URL ?? 'http://catalog:3000/catalog/feed'
const INTERVAL_MS = 5000

async function poll(): Promise<void> {
  const since = await readCursor('catalog')
  const res = await fetch(`${FEED}?since=${since}`)
  if (!res.ok) throw new Error(`catalog feed responded ${res.status}`)

  const body = await res.json()
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
}
```

Three details carry all the weight:

**The cursor lives in the consumer's database** (`feed_cursor`, `checkout/src/db.ts:21`).
Not in the producer, not in a broker. Checkout decides what it has read. Nobody
can move that pointer on its behalf, and resetting it to 0 is a full, safe
re-sync.

**The upsert is idempotent.** `ON CONFLICT (sku) DO UPDATE` means applying the
same event twice produces the same row. This is what makes at-least-once delivery
acceptable: the consumer does not need exactly-once, it needs a write that does
not care.

**A failed poll is not an error.** `checkout/src/replica.ts:44`

```ts
poll().catch((err) => console.warn(`[replica] catalog unreachable, keeping local copy: ${err.message}`))
```

Catalog being down means the replica stops advancing. It does not mean checkout
stops working. That is the difference between stale and broken, and it is worth
saying out loud: **stale data that sells is worth more than fresh data that 500s.**

### 4. The consumer reads only its own tables

`checkout/src/server.ts:14`

```ts
async function cart(): Promise<CartRow[]> {
  const { rows } = await pool.query<CartRow>(
    `SELECT ci.sku, ci.qty, pr.name, pr.price_cents, pr.updated_at
       FROM cart_items ci
       LEFT JOIN product_replica pr ON pr.sku = ci.sku
      ORDER BY ci.sku`,
  )
  return rows
}
```

`cart_items` and `product_replica` are both in `checkout_db`. Rendering a cart
touches one database, one query, zero networks. It cannot fail because of another
team's deploy.

## The same pattern, one hop further

`orders` does exactly this against checkout, in a different language, with no
shared code between them.

`orders/app/replica.py:17`

```python
def _poll() -> None:
    since = read_cursor("checkout")
    body = httpx.get(FEED, params={"since": since}, timeout=5.0).raise_for_status().json()

    for event in body["events"]:
        if event["type"] != "OrderPlaced":
            continue
        with pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO orders (id, placed_at, total_cents, items)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
                """,
                (event["orderId"], event["at"], event["totalCents"], json.dumps(event["items"])),
            )

    write_cursor("checkout", body["nextSince"])
```

Same shape: cursor, poll, idempotent write, own database. Different language,
different HTTP client, different driver. Nothing is shared but the JSON, and the
consumer parses only the fields it cares about.

Note what `OrderPlaced` carries: `items` includes `name` and `priceCents` copied
in at the moment of the order. Orders never needs to look up a product, and an
order from last March still shows the price actually paid, not today's price.
Events that carry their own facts are what let a consumer stop depending on
anybody.

## Writing the event in the same transaction as the state

The one place this can quietly break: publishing an event about a change that did
not commit, or committing a change whose event was lost.

`checkout/src/server.ts:92`

```ts
await client.query('BEGIN')
await client.query('INSERT INTO orders (id, total_cents) VALUES ($1, $2)', [id, total(rows)])
await client.query(
  `INSERT INTO order_events (type, order_id, payload)
   VALUES ('OrderPlaced', $1, $2)`,
  [id, JSON.stringify({ orderId: id, totalCents: total(rows), items })],
)
await client.query('DELETE FROM cart_items')
await client.query('COMMIT')
```

The order, the event and the cart clear commit or roll back together, because
they live in one database. The feed can never disagree with the system's own
state.

This is the **transactional outbox** pattern. It is usually introduced as a
workaround for brokers, where the event goes to Kafka and the state goes to
Postgres and the two can diverge. Here the outbox *is* the feed, so the problem
never appears.

## What we consciously gave up

**Consistency is eventual, and visible.** For up to five seconds, checkout prices
a cart at the old price. The cart page says so, in `checkout/src/server.ts`:

> Names and prices come from checkout's own replica of the catalog feed, last
> updated 2026-08-24T18:22:11Z. This page never calls catalog.

The honest answer to "what if the price changed?" is a business answer, not a
technical one: the price shown when the customer clicked is arguably the price
they should pay. Most commerce systems already work this way and call it a
feature.

**Data is duplicated.** `product_replica` in checkout is a copy of `products` in
catalog. This is intentional and it is not denormalization: catalog stores the
product, checkout stores *what it needs to price a line item*, which is a
narrower thing that happens to overlap. When catalog adds a field, checkout is
not affected and does not redeploy.

**Polling costs a request per system per interval.** At four systems and five
seconds, that is under one request per second. At real volume the feed contract
does not change; only the transport does (conditional GETs with ETags, longer
intervals for slow-moving data, or a broker pushing the same events). The
consumers keep their cursors and their idempotent writes either way.

## What would break the model

Each of these is a shortcut that would make this repo a distributed monolith:

- `checkout` querying `catalog_db` directly. Prevented at the engine level, see
  `db/init.sql`: three roles, three databases, no `CONNECT` grant across them.
- `checkout` calling `GET /catalog/products/:sku` while rendering a cart. This is
  the one that looks harmless and is not: it reintroduces the runtime dependency
  that all of the above exists to remove.
- A shared `packages/product` with the `Product` type. It looks like reuse, but it
  makes catalog's refactor a checkout release, which is exactly the coupling we
  paid for with duplication.
- Events carrying only an id (`{"type": "ProductChanged", "sku": "KB-01"}`), which
  forces the consumer to call back for the details. Then the feed is just a
  slower way to be synchronously coupled.

## Try it

```sh
# see the raw contract
sh demo/watch-feeds.sh

# change a price in catalog, then watch it reach checkout
curl -s -o /dev/null -X POST -d 'sku=KB-01' http://localhost:8080/catalog/admin/bump
docker compose logs -f checkout    # [replica] applied 1 event(s) from catalog, cursor=5

# prove the replica stands on its own
sh demo/kill-catalog.sh
```
