import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { localeCookieName, resolveLocale } from './config'
import deMessages from '../../messages/de.json'
import enMessages from '../../messages/en.json'

const messagesByLocale = { de: deMessages, en: enMessages } as const

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const locale = resolveLocale(cookieStore.get(localeCookieName)?.value)

  return {
    locale,
    // Static imports keep both catalogs in Turbopack's module graph so edits
    // are picked up by Fast Refresh without restarting the development server.
    messages: messagesByLocale[locale],
  }
})
