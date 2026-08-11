'use client'

import { useId } from 'react'
import {
  displayDateOptions,
  displayDateTimeOptions,
  formatDisplayDateForLocale,
  formatDisplayDateTimeForLocale,
  serializeInlineScriptValue,
} from './dateFormatting'
import { useRegionalFormat } from './RegionalFormatProvider'
import type { RegionalFormat } from './regionalFormat'

function InlineScript({ html }: { html: string }) {
  return <script
    type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
    suppressHydrationWarning
    dangerouslySetInnerHTML={{ __html: html }}
  />
}

function inlineDateScript(id: string, value: string, options: Intl.DateTimeFormatOptions, preference: RegionalFormat) {
  const idJson = serializeInlineScriptValue(id)
  const valueJson = serializeInlineScriptValue(value)
  const optionsJson = serializeInlineScriptValue(options)
  const parse = `var v=${valueJson},p=/^\\d{4}-\\d{2}-\\d{2}$/.test(v)?v.split('-').map(Number):null,d=p?new Date(p[0],p[1]-1,p[2]):new Date(v);if(p&&(d.getFullYear()!==p[0]||d.getMonth()!==p[1]-1||d.getDate()!==p[2]))d=new Date(NaN);`
  const locale = preference === 'system'
    ? `(navigator.languages&&navigator.languages.length?navigator.languages[0]:navigator.language)||'en-US'`
    : serializeInlineScriptValue(preference)
  const format = `if(!Number.isNaN(d.valueOf()))n.textContent=new Intl.DateTimeFormat(${locale},${optionsJson}).format(d)`
  return `(function(){var n=document.getElementById(${idJson});if(!n)return;${parse}${format}})()`
}

type LocalDateProps = {
  value: string
  options?: Intl.DateTimeFormatOptions
  className?: string
  title?: string
}

/** A browser-locale date with an inline pre-paint correction for SSR. */
export function LocalDate({ value, options = displayDateOptions, className, title }: LocalDateProps) {
  const id = useId()
  const { locale, preference } = useRegionalFormat()
  return <>
    <time id={id} dateTime={value} className={className} title={title} suppressHydrationWarning>
      {formatDisplayDateForLocale(value, locale)}
    </time>
    <InlineScript html={inlineDateScript(id, value, options, preference)} />
  </>
}

/** A browser-locale date-time with an inline pre-paint correction for SSR. */
export function LocalDateTime({ value, options = displayDateTimeOptions, className, title }: LocalDateProps) {
  const id = useId()
  const { locale, preference } = useRegionalFormat()
  return <>
    <time id={id} dateTime={value} className={className} title={title} suppressHydrationWarning>
      {formatDisplayDateTimeForLocale(value, locale)}
    </time>
    <InlineScript html={inlineDateScript(id, value, options, preference)} />
  </>
}
