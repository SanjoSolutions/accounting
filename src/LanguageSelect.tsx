'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useCallback, useTransition, type ChangeEvent } from 'react'
import { setLocale } from './i18n/actions'
import { locales } from './i18n/config'

export function LanguageSelect() {
  const locale = useLocale()
  const t = useTranslations('LanguageSelect')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const onChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextLocale = event.target.value
      startTransition(async () => {
        await setLocale(nextLocale)
        router.refresh()
      })
    },
    [router],
  )

  return (
    <select
      className="form-select d-inline-block w-auto"
      aria-label={t('label')}
      value={locale}
      onChange={onChange}
      disabled={isPending}
    >
      {locales.map((languageCode) => (
        <option key={languageCode} value={languageCode}>{t(languageCode)}</option>
      ))}
    </select>
  )
}
