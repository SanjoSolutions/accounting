import 'bootstrap-icons/font/bootstrap-icons.css'
import '../theme.scss'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { cookies } from 'next/headers'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import '../index.css'
import { AppShell } from '../AppShell'
import { LanguageSelect } from '../LanguageSelect'
import { Navbar } from '../Navbar'
import { getAuthMode, isSignUpEnabled } from '@/server/auth-mode'
import { getCurrentUser } from '@/server/authentication'
import { Providers } from './providers'
import { regionalFormatCookieName, resolveRegionalFormat, resolveServerRegionalLocale } from '../regionalFormat'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata')

  return {
    title: t('title'),
    description: t('description'),
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()
  const authMode = getAuthMode()
  const requestHeaders = await headers()
  const user = await getCurrentUser(requestHeaders)
  const regionalFormat = resolveRegionalFormat((await cookies()).get(regionalFormatCookieName)?.value)
  const serverLocale = resolveServerRegionalLocale(requestHeaders.get('accept-language'))

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <Providers regionalFormat={regionalFormat} serverLocale={serverLocale}>
            <Navbar authMode={authMode} signUpEnabled={isSignUpEnabled()} user={user} />
            <AppShell>
              <div className="row mb-2">
                <div className="col">
                  <div className="page-content">{children}</div>
                  <footer className="app-footer mt-5 border-top pt-2 text-end">
                    <LanguageSelect />
                  </footer>
                </div>
              </div>
            </AppShell>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
