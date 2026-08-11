'use client'

import { useId } from 'react'
import { formatCurrencyFromCents, formatCurrencyFromUnits, formatCount, formatNumber, formatPercentBasisPoints, formatPercentFraction, formatPercentUnits, inlineNumberScript, type NumberFormatOptions } from './numberFormatting'
import { useRegionalFormat } from './RegionalFormatProvider'
import type { RegionalFormat } from './regionalFormat'

function InlineScript({ html }: { html: string }) {
  return <script
    type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
    suppressHydrationWarning
    dangerouslySetInnerHTML={{ __html: html }}
  />
}

type LocalNumberProps = {
  value: number
  options?: NumberFormatOptions
  className?: string
  title?: string
}

function LocalNumberValue({ value, options = {}, className, title, format }: LocalNumberProps & { format: (value: number, locale: string) => string }) {
  const id = useId()
  const { locale, preference } = useRegionalFormat()
  const scriptOptions = options
  return <>
    <span id={id} className={className} title={title} suppressHydrationWarning>{format(value, locale)}</span>
    <InlineScript html={inlineNumberScript(id, value, scriptOptions, preference)} />
  </>
}

/** A regional number with an inline pre-paint correction for SSR. */
export function LocalNumber(props: LocalNumberProps) {
  return <LocalNumberValue {...props} format={(value, locale) => formatNumber(value, locale, props.options)} />
}

/** A regional integer count with grouping. */
export function LocalCount({ value, className, title }: Omit<LocalNumberProps, 'options'>) {
  return <LocalNumberValue value={value} className={className} title={title} options={{ maximumFractionDigits: 0 }} format={formatCount} />
}

export function LocalCurrency({ cents, currency, className, title }: { cents: number; currency: string; className?: string; title?: string }) {
  return <LocalNumberValue value={cents / 100} className={className} title={title} options={{ style: 'currency', currency }} format={(value, locale) => formatCurrencyFromUnits(value, currency, locale)} />
}

export function LocalCurrencyUnits({ value, currency, className, title }: { value: number; currency: string; className?: string; title?: string }) {
  return <LocalNumberValue value={value} className={className} title={title} options={{ style: 'currency', currency }} format={(amount, locale) => formatCurrencyFromUnits(amount, currency, locale)} />
}

export function LocalPercentFraction({ value, options, className, title }: { value: number; options?: NumberFormatOptions; className?: string; title?: string }) {
  return <LocalNumberValue value={value} className={className} title={title} options={{ style: 'percent', ...options }} format={(fraction, locale) => formatPercentFraction(fraction, locale, options)} />
}

export function LocalPercentUnits({ value, options, className, title }: { value: number; options?: NumberFormatOptions; className?: string; title?: string }) {
  return <LocalNumberValue value={value / 100} className={className} title={title} options={{ style: 'percent', ...options }} format={(units, locale) => formatPercentUnits(units * 100, locale, options)} />
}

export function LocalPercentBasisPoints({ value, options, className, title }: { value: number; options?: NumberFormatOptions; className?: string; title?: string }) {
  return <LocalNumberValue value={value / 10_000} className={className} title={title} options={{ style: 'percent', ...options }} format={(basisPoints, locale) => formatPercentBasisPoints(basisPoints * 10_000, locale, options)} />
}

// Keep the pure helpers available to client components that need a localized
// string inside a translated status message rather than a standalone node.
export { formatCount, formatCurrencyFromCents, formatCurrencyFromUnits, formatNumber, formatPercentBasisPoints, formatPercentFraction, formatPercentUnits }

export type { RegionalFormat }
