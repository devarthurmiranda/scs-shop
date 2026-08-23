export const money = (cents: number) => `$ ${(cents / 100).toFixed(2)}`

export const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escape(title)}</title>
  <link rel="stylesheet" href="/assets/design.css?v=1">
</head>
<body>
  <header class="scs-header">
    <a href="/catalog">Shop</a>
    <a href="/orders/">Orders</a>
    <span class="spacer"></span>
    <span class="owner">checkout &middot; fastify</span>
  </header>
  ${body}
</body>
</html>`
}
