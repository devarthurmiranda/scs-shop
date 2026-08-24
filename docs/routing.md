# Routing three stacks under one domain

Three systems, three languages, three HTTP servers, and the user must see one
website at one hostname. This document explains how `localhost:8080` becomes
Next.js, Fastify and FastAPI without any of them knowing the others exist, and
which details break it if you get them wrong.

## The shape

```
  browser  ->  http://localhost:8080/checkout/cart
                        |
                  +-----------+
                  |  router   |   nginx, one config file, no logic
                  +-----------+
                   /     |     \
        /catalog  /   /checkout \  /orders
             |         |          |
     catalog:3000  checkout:3001  orders:8000
       Next.js       Fastify       FastAPI
```

One public origin. Three private ones the browser can never reach: in
`docker-compose.yml` only the router publishes a port, so `catalog:3000` exists
only on the compose network.

## The routing rule: one prefix per system

`router/nginx.conf`

```nginx
location = / {
    return 302 /catalog;
}

location /catalog {
    proxy_set_header Accept-Encoding "";
    proxy_set_header Host $http_host;
    proxy_pass http://catalog:3000;
    proxy_intercept_errors on;
    error_page 502 503 504 = @catalog_down;
}

location /checkout {
    proxy_set_header Accept-Encoding "";
    proxy_set_header Host $http_host;
    proxy_pass http://checkout:3001;
}

location /orders {
    proxy_set_header Accept-Encoding "";
    proxy_set_header Host $http_host;
    proxy_pass http://orders:8000;
}
```

That is the entire routing layer. Note what is **not** in it:

- no authentication
- no request aggregation or response merging
- no rate limiting per route, no request rewriting, no business rules
- no list of endpoints, only three prefixes

Adding a page to checkout does not touch this file. Adding a fourth system adds
three lines. **The router is boring on purpose**: the moment it holds logic, it
becomes a component every team must coordinate on to deploy, and you have
rebuilt the shared layer that SCS removes.

Path prefixes are one option. `catalog.shop.com` / `checkout.shop.com` also
works and gives real origin isolation, at the price of cookie scoping and CORS
for anything cross-system. Prefixes on one origin are simpler and keep the site
looking like one site, which is why this demo uses them.

## The part everyone gets wrong: the prefix is not stripped

`proxy_pass http://catalog:3000;` with no URI component passes the **full**
original path upstream. A request for `/catalog/feed` arrives at Next.js as
`/catalog/feed`, not `/feed`.

That is deliberate, and it is the single most important decision in this file.
Each system knows its own prefix and generates its own URLs:

`catalog/next.config.ts`

```ts
const config: NextConfig = {
  // Every SCS owns a URL prefix. The router does not rewrite paths.
  basePath: '/catalog',
  compress: false,
}
```

Fastify declares full paths (`app.get('/checkout/cart', ...)`), FastAPI does the
same (`@app.get("/orders/")`).

The alternative, `proxy_pass http://catalog:3000/;` with a trailing slash, strips
the prefix so the app sees `/feed` and believes it is mounted at the root. It
works for exactly one request and then falls apart:

| What breaks | Why |
|---|---|
| Every asset 404s | The app emits `/_next/static/...`, the router has no rule for it |
| Redirects escape the prefix | The app sends `Location: /cart`, the browser leaves checkout |
| Client-side navigation dies | The router built the URL, the app does not know about it |
| Absolute links in HTML | Anything the app renders is missing `/checkout` |

You then patch it with `sub_filter`, rewrite rules and header rewriting, and the
router grows the logic we just said it must not have. Every fix lives in the
router instead of in the system that owns the URL.

**Keep the prefix. Let each system own its own address space.** The router should
never need to know what a URL means.

## Owning the prefix means owning everything under it

Because the prefix survives, each system serves its own static assets under it
with no router involvement:

```
/catalog/_next/static/chunks/...   Next.js build output
/checkout/fragment/minicart        a UI fragment
/orders/                           a Jinja template
```

Three build pipelines, three asset strategies, zero collisions and zero router
config. Next.js can change its asset hashing scheme, and nginx never finds out.

The one shared path is deliberate and static:

```nginx
location /assets/ {
    alias /usr/share/nginx/assets/;
}
```

`design.css`, served by the router, versioned in the URL (`?v=1`), containing no
logic. Shared assets keep the site visually coherent. Shared *code* would couple
release cycles, which is why the line is drawn exactly here.

## Trailing slashes, which is where the afternoon goes

Next.js with `basePath: '/catalog'` treats `/catalog` as canonical and answers
`/catalog/` with a 308 to `/catalog`. FastAPI does the opposite: routes declared
as `/orders/` redirect `/orders` to `/orders/`.

If nginx matches `location /catalog/` (with the slash), a request for `/catalog`
never matches that block at all, falls through, and 404s. This actually happened
while building this repo.

The fix is to match the prefix without a trailing slash:

```nginx
location /catalog { ... }
```

which matches `/catalog`, `/catalog/`, and everything under it, and lets each
framework apply whatever slash convention it prefers. The frameworks disagree
with each other, and the router is indifferent to the disagreement. That is the
correct division of responsibility.

## Two headers that are not optional

```nginx
proxy_set_header Host $http_host;
```

`$http_host` keeps the port, `$host` drops it. With `$host`, any absolute
redirect a system builds from the `Host` header points at `localhost` and the
browser tries port 80. This is silent in production behind :443 and breaks every
local setup, which is the worst combination.

Better still, avoid the class of bug entirely by returning **relative**
`Location` headers, as every system here does:

```ts
return new Response(null, { status: 303, headers: { Location: '/catalog' } })
```

A system that never reconstructs its own absolute URL cannot get it wrong.

```nginx
proxy_set_header Accept-Encoding "";
```

This tells the upstream not to compress, because nginx cannot run SSI over a
gzipped response body. `catalog/next.config.ts` also sets `compress: false` as a
belt-and-braces measure. Without this the catalog page renders with the raw
`<!--#include ... -->` comment sitting in the HTML, doing nothing, and it looks
like an SSI syntax error rather than a compression problem.

## Routing between systems: use plain links

Cross-system navigation is a `<a href>` or a `<form action>`. That is the whole
mechanism.

`catalog/app/page.tsx:26`

```tsx
<form action="/checkout/cart/items" method="post">
  <input type="hidden" name="sku" value={p.sku} />
  <button type="submit">Add to cart</button>
</form>
```

The catalog page, rendered by Next.js, posts a form straight into a Fastify
route. No API client, no fetch wrapper, no shared types, no CORS (same origin),
no service discovery. Checkout answers `303 See Other` with `Location: /catalog`
and the browser goes back.

This works precisely *because* the router does not strip prefixes. `/checkout/cart/items`
means the same thing in the browser, in the HTML, and in the nginx config.

Cross-system links are the cheapest integration in existence and the one most
teams skip on the way to building a gateway.

## Composing UI across systems, still through the router

A link moves the whole page. Sometimes you need a piece of one system inside
another: the mini-cart in the catalog header belongs to checkout, because
checkout owns the cart.

`catalog/app/layout.tsx:8`

```tsx
const MINICART = `<!--#block name="minicart_down" --><a href="/checkout/cart">Cart</a><!--#endblock --><!--#include virtual="/checkout/fragment/minicart" stub="minicart_down" -->`
```

nginx has `ssi on`. It parses catalog's HTML response, sees the include, issues an
internal subrequest to `/checkout/fragment/minicart`, and splices the result in
before the browser gets a single byte. The `virtual` path goes through the same
`location` blocks as any request, so transclusion and routing are the same
mechanism.

Checkout serves the fragment as ordinary HTML:

```ts
app.get('/checkout/fragment/minicart', async (_req, reply) => {
  const rows = await cart()
  const count = rows.reduce((n, r) => n + r.qty, 0)
  reply.type('text/html')
  return `<a href="/checkout/cart">Cart (${count}) &middot; ${money(total(rows))}</a>`
})
```

The browser sees one document from one origin. No iframe, no client-side fetch,
no CORS, no JavaScript required. Catalog does not import anything from checkout
and does not know how a cart is counted.

## Failure is a routing concern, and only here

A system being down must degrade the page, not delete it.

**Fragment down.** The `stub="minicart_down"` block renders when the subrequest
fails, so a stopped checkout turns the live mini-cart into a plain `Cart` link:

```sh
docker compose stop checkout
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/catalog   # 200
```

The page still returns 200. Graceful degradation is a property of SSI, not
something the catalog team wrote.

**Whole system down.** `proxy_intercept_errors on` plus a named location turns a
raw 502 into an explanation that keeps the rest of the site reachable:

```nginx
location @catalog_down {
    default_type text/html;
    return 503 '... Only browsing is affected.
                <a href="/checkout/cart">Your cart</a> and
                <a href="/orders/">your orders</a> still work.';
}
```

This is the acceptable exception to "no logic in the router": it is a static
fallback, it holds no business rule, and it is the only place that *can* answer
when the system that owns the page is not running.

Everything else about resilience is solved in the systems themselves, by not
needing each other at request time. See [sharing_data.md](sharing_data.md).

## Checklist for adding a fourth system

1. Pick a prefix nobody else owns, say `/search`.
2. Configure the framework to mount at that prefix (`basePath`, router prefix,
   `root_path`, whatever it is called). Do not strip it in the router.
3. Add the three-line `location /search` block.
4. Serve assets under `/search/...`, link the shared `/assets/design.css`.
5. Link to peers with `<a href>`; expose fragments for anyone who wants to
   transclude; publish a feed if you own data others need.
6. Never call a peer while serving a request.

No other file in this repository changes.

## What this deliberately is not

**Not an API gateway.** No auth, no aggregation, no transformation. A gateway
that knows about endpoints becomes a deployment bottleneck shared by every team.

**Not a BFF.** There is no single backend composing responses for a single
frontend, because there is no single frontend.

**Not micro-frontends in the SPA sense.** No module federation, no runtime
JavaScript bundle stitching, no shared React root. Composition happens in HTML,
on the server, and works with JavaScript disabled.

**Not load balancing or service discovery.** Docker's embedded DNS resolves
`catalog`, `checkout` and `orders` on the compose network. In production that
role is filled by Kubernetes Services or an Ingress with the same three rules,
and the model does not change.
