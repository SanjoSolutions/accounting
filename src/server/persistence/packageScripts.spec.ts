import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Prisma development startup', () => {
  it('applies committed migrations and generates the Prisma client before starting Next.js', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.dev).toBe('prisma migrate deploy && prisma generate && next dev')
  })
})
