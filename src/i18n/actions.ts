'use server'

import { cookies } from 'next/headers'
import { isLocale, localeCookieName } from './config'

export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) {
    throw new Error(`Unsupported locale: ${locale}`)
  }

  const cookieStore = await cookies()
  cookieStore.set(localeCookieName, locale, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/',
  })
}
