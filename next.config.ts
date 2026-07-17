import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const nextConfig: NextConfig = {
  // Native dependencies used by storage and the isolated thumbnail worker.
  serverExternalPackages: ['@napi-rs/canvas', 'opendal', 'pdfjs-dist'],
  outputFileTracingIncludes: {
    '/api/documents': ['./src/server/documentThumbnailWorker.mjs'],
  },
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
