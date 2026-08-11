'use server'

import { cookies } from 'next/headers'
import { isRegionalFormat, regionalFormatCookieName } from './regionalFormat'

export async function setRegionalFormat(format: string): Promise<void> {
  if (!isRegionalFormat(format)) throw new Error(`Unsupported regional format: ${format}`)

  const cookieStore = await cookies()
  cookieStore.set(regionalFormatCookieName, format, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/',
  })
}
