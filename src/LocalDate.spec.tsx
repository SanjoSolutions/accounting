import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { LocalDate, LocalDateTime } from './LocalDate'

describe('browser-locale date components', () => {
  test('renders a semantic date and a pre-paint browser formatter without changing the canonical value', () => {
    const markup = renderToStaticMarkup(<LocalDate value="2026-08-09" />)

    expect(markup).toContain('dateTime="2026-08-09"')
    expect(markup).toContain('2026-08-09')
    expect(markup).toContain('new Date(p[0],p[1]-1,p[2])')
    expect(markup).toContain('Intl.DateTimeFormat((navigator.languages&&navigator.languages.length?navigator.languages[0]:navigator.language)||\'en-US\',{"dateStyle":"medium"})')
  })

  test('formats instants with a localized time and keeps the canonical instant in dateTime', () => {
    const markup = renderToStaticMarkup(<LocalDateTime value="2026-08-09T10:15:00.000Z" />)

    expect(markup).toContain('dateTime="2026-08-09T10:15:00.000Z"')
    expect(markup).toContain('new Date(v)')
    expect(markup).toContain('"timeStyle":"short"')
  })

  test('escapes untrusted values before embedding them in the inline script', () => {
    const markup = renderToStaticMarkup(<LocalDate value={'2026-08-09</script><script>alert(1)'} />)

    expect(markup).not.toContain('</script><script>alert(1)')
    expect(markup).toContain('\\u003c/script\\u003e')
  })
})
