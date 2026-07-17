import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

export const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  // Native dependencies used by storage and the isolated thumbnail worker.
  serverExternalPackages: ['@napi-rs/canvas', 'opendal', 'pdfjs-dist'],
  outputFileTracingIncludes: {
    '/api/documents': ['./src/server/documentThumbnailWorker.mjs'],
  },
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
