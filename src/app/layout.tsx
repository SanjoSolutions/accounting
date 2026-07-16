import 'bootstrap-icons/font/bootstrap-icons.css'
import 'bootstrap/dist/css/bootstrap.css'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../index.css'
import { LanguageSelect } from '../LanguageSelect'
import { Navbar } from '../Navbar'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'Accounting',
  description: 'Accounting application',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
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
      </body>
    </html>
  )
}
