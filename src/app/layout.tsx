import 'bootstrap-icons/font/bootstrap-icons.css'
import 'bootstrap/dist/css/bootstrap.css'
import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import '../index.css'
import { LanguageSelect } from '../LanguageSelect'
import { Navbar } from '../Navbar'
import { Providers } from './providers'

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

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <Providers>
            <Navbar />
            <main className="container">
              <div className="row mb-2">
                <div className="col">
                  {children}
                  <div className="mt-5 border-top pt-2 text-end">
                    <LanguageSelect />
                  </div>
                </div>
              </div>
            </main>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
