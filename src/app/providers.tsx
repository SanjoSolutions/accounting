"use client"

import { getApps, initializeApp } from 'firebase/app'
import { useEffect, type ReactNode } from 'react'
import { firebaseConfig } from '../firebaseConfig'
import { getLanguage } from '../getLanguage'
import i18n from '../i18n'

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    const language = getLanguage()
    if (language) {
      void i18n.changeLanguage(language)
    }

    if (firebaseConfig.apiKey && getApps().length === 0) {
      initializeApp(firebaseConfig)
    }
  }, [])

  return children
}
