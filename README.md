# scs-shop

A four-system e-commerce demo of **Self-Contained Systems**, built to be shown live.

Every system owns its UI, its logic and its data. Nothing shares a database, nothing
shares business code, and no system calls another one while serving a request.

```
                    localhost:8080
                          |
                    +-----------+
                    |  router   |   nginx: path routing + SSI. No logic.
                    +-----------+
         /catalog        |  /checkout        |  /orders
              |          |       |           |     |
      +---------------+  |  +---------------+  +---------------+
      |    catalog    |  |  |   checkout    |  |    orders     |
      |   Next.js 15  |  |  |  Fastify 5    |  |  FastAPI      |
      |  TypeScript   |  |  |  TypeScript   |  |  Python 3.13  |
      +---------------+  |  +---------------+  +---------------+
      |  catalog_db   |     | checkout_db   |  |  orders_db    |
      +---------------+     +---------------+  +---------------+
              |                     ^                  ^
              |  GET /catalog/feed  |                  |
              +---------------------+                  |
                          GET /checkout/feed           |
                                    +------------------+
```

Three languages, three frameworks, three databases, four Dockerfiles. On purpose.

## Run it

```sh
docker compose up --build
open http://localhost:8080
```

## The three claims, and how to show each one

### 1. Each SCS owns its own UI

There is no shared frontend, no BFF, no SPA shell. Each system renders its own HTML.
The header badge on every page names the system that produced it.

Composition happens in two places, and both are the cheapest technique available:

**Links.** The "Add to cart" button on the catalog page is a plain `<form method="post">`
posting directly into checkout. No API client, no shared DTO, no generated types.
See `catalog/app/page.tsx`.

**Server-side transclusion.** The mini-cart in the catalog header is a fragment owned and
rendered by checkout, pulled in by nginx before the browser ever sees the page:

```html
<!--#block name="minicart_down" --><a href="/checkout/cart">Cart</a><!--#endblock -->
<!--#include virtual="/checkout/fragment/minicart" stub="minicart_down" -->
```

Stop checkout and reload `/catalog`. The page still returns 200: the stub block renders
a plain link instead. Graceful degradation is a property of the technique, not something
we coded.

### 2. Integration is asynchronous, and it does not need a broker

Each system publishes an append-only feed over plain HTTP, and consumers poll it and
keep their own cursor.

```sh
sh demo/watch-feeds.sh
```

`catalog` publishes `ProductChanged`. `checkout` polls it every 5s and writes product
names and prices into `product_replica`, its own table in its own database.
`checkout` publishes `OrderPlaced`. `orders` polls that and builds order history from it.

Click **Raise price** on the catalog page, wait five seconds, open the cart. The new price
is there. Nothing called anything: catalog appended a row, checkout read it on its own
schedule.

Eventual consistency is visible, not hidden. The cart page says where its data came from
and how old it is.

The order and its event are written in one transaction (`checkout/src/server.ts`), so
the feed can never disagree with the system's own state.

### 3. A system survives its peers being down

This is the payoff.

```sh
sh demo/kill-catalog.sh
```

With `catalog` stopped: browsing is gone (correctly, it is catalog's job), but the cart
still lists product names and prices, and an order can still be placed and shows up in
order history. checkout holds everything it needs in `checkout_db`.

A microservices demo where `catalog` is a REST dependency of `checkout` fails this test.

## What is deliberately shared, and what is not

**Shared:** one CSS file, versioned, served by the router at `/assets/design.css`.
Assets keep the look consistent. It contains no components and no logic, so it cannot
couple two systems' release cycles.

**Not shared:** database, ORM, domain model, HTTP client, types, utility library.
There is no `packages/common`, and that absence is the design.

## Boundaries you can check

One Postgres container, three databases, three roles:

```sh
docker compose exec postgres psql -U checkout -d catalog_db   # permission denied
```

Postgres cannot query across databases, and no role can connect to another system's
database. The boundary is enforced by the engine, not by a code review.

## Docs

- [docs/sharing_data.md](docs/sharing_data.md) - how one system gets data it does not own,
  traced through the raise-price example end to end: append-only feed, consumer-held
  cursor, idempotent upsert, and why stale beats broken.
- [docs/routing.md](docs/routing.md) - how three stacks live under one hostname without
  colliding: prefix ownership, why the router must not strip the prefix, trailing slashes,
  cross-system links, and SSI transclusion.

## Layout

```
catalog/         Next.js 15, React 19, TypeScript      -> catalog_db
checkout/        Fastify 5, TypeScript                 -> checkout_db
orders/          FastAPI, Jinja2, Python 3.13          -> orders_db
router/          nginx.conf: routing + SSI
shared-assets/   design.css, the only shared thing
db/init.sql      three roles, three databases
demo/            the two scripts you run on stage
docs/            sharing_data.md, routing.md
```

## Honest limitations of this demo

Worth stating out loud, because someone will ask:

- **One repo, one compose file.** Real SCS means independent repos and independent deploy
  pipelines. The boundary here is enforced by the build and the database, not the folder.
- **One Postgres container.** Three databases with three roles gives the same isolation
  guarantee, in one container instead of three.
- **One global cart, no sessions or auth.** Removed to keep the code readable on a projector.
- **Polling every 5 seconds.** Fine at this scale. At real volume the feed stays the same
  and only the transport changes (conditional GETs, or a broker); the contract does not.
