import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

export const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  // OpenDAL ships a platform-specific native binary that must stay external to
  // the Next.js server bundle.
  serverExternalPackages: ['opendal'],
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
