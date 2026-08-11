'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { setRegionalFormat } from './regionalFormatActions'
import { resolveBrowserRegionalLocale, regionalLocaleFor, type RegionalFormat } from './regionalFormat'

type RegionalFormatContextValue = {
  preference: RegionalFormat
  locale: string
  serverLocale: string
  setPreference: (next: RegionalFormat) => Promise<void>
}

const RegionalFormatContext = createContext<RegionalFormatContextValue>({
  preference: 'system',
  locale: 'en-US',
  serverLocale: 'en-US',
  setPreference: async () => undefined,
})

export function RegionalFormatProvider({ children, initialPreference = 'system', serverLocale = 'en-US' }: {
  children: ReactNode
  initialPreference?: RegionalFormat
  serverLocale?: string
}) {
  const [preference, setPreferenceState] = useState<RegionalFormat>(initialPreference)
  const [browserLocale, setBrowserLocale] = useState(serverLocale)

  useEffect(() => {
    setBrowserLocale(resolveBrowserRegionalLocale())
  }, [])

  const setPreference = useCallback(async (next: RegionalFormat) => {
    setPreferenceState(next)
    await setRegionalFormat(next)
  }, [])

  const value = useMemo<RegionalFormatContextValue>(() => ({
    preference,
    locale: regionalLocaleFor(preference, browserLocale),
    serverLocale,
    setPreference,
  }), [browserLocale, preference, serverLocale, setPreference])

  return <RegionalFormatContext.Provider value={value}>{children}</RegionalFormatContext.Provider>
}

export function useRegionalFormat() {
  return useContext(RegionalFormatContext)
}
