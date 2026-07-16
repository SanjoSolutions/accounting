"use client"

import { getApps, initializeApp } from 'firebase/app'
import { useEffect, type ReactNode } from 'react'
import { firebaseConfig } from '../firebaseConfig'

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (firebaseConfig.apiKey && getApps().length === 0) {
      initializeApp(firebaseConfig)
    }
  }, [])

  return children
}
