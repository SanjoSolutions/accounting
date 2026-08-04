import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

export const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ')

export const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

export const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  async headers() { return [{ source: '/:path*', headers: securityHeaders }] },
  sassOptions: {
    silenceDeprecations: ['color-functions', 'global-builtin', 'if-function', 'import'],
  },
  // Native dependencies used by storage and the isolated thumbnail worker.
  serverExternalPackages: ['@napi-rs/canvas', 'opendal', 'pdfjs-dist'],
  outputFileTracingIncludes: {
    '/api/documents': ['./src/server/documentThumbnailWorker.mjs'],
  },
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
