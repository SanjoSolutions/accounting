"use client"

import type { ReactNode } from 'react'
import { RegionalFormatProvider } from '../RegionalFormatProvider'
import type { RegionalFormat } from '../regionalFormat'

export function Providers({ children, regionalFormat = 'system', serverLocale = 'en-US' }: {
  children: ReactNode
  regionalFormat?: RegionalFormat
  serverLocale?: string
}) {
  return <RegionalFormatProvider initialPreference={regionalFormat} serverLocale={serverLocale}>{children}</RegionalFormatProvider>
}
