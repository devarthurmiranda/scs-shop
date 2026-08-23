import type { ReactNode } from 'react'

export const metadata = { title: 'Catalog' }

// Server-side transclusion. nginx resolves this include before the browser
// sees the page. If checkout is down the stub block is rendered instead,
// so this page never breaks because of a peer.
const MINICART = `<!--#block name="minicart_down" --><a href="/checkout/cart">Cart</a><!--#endblock --><!--#include virtual="/checkout/fragment/minicart" stub="minicart_down" -->`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/assets/design.css?v=1" />
      </head>
      <body>
        <header className="scs-header">
          <a href="/catalog">Shop</a>
          <a href="/orders/">Orders</a>
          <span className="spacer" />
          <span className="owner">catalog · next.js</span>
          <span dangerouslySetInnerHTML={{ __html: MINICART }} />
        </header>
        {children}
      </body>
    </html>
  )
}
