import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const nextConfig: NextConfig = {
  // OpenDAL ships a platform-specific native binary that must stay external to
  // the Next.js server bundle.
  serverExternalPackages: ['opendal'],
}

const withNextIntl = createNextIntlPlugin()

export default withNextIntl(nextConfig)
