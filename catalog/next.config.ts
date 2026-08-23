import type { NextConfig } from 'next'

const config: NextConfig = {
  // Every SCS owns a URL prefix. The router does not rewrite paths.
  basePath: '/catalog',
  // nginx cannot run SSI over a gzipped upstream response.
  compress: false,
}

export default config
