import 'server-only'

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/generated/prisma/client'
import { resolveApplicationDatabaseUrl } from '../../../tools/db-safety.mjs'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaDatabaseUrl?: string }

export function getPrismaClient(): PrismaClient {
  const databaseUrl = resolveApplicationDatabaseUrl()
  if (globalForPrisma.prisma && globalForPrisma.prismaDatabaseUrl === databaseUrl) return globalForPrisma.prisma

  const adapter = new PrismaBetterSqlite3({
    url: databaseUrl,
  })
  const prisma = new PrismaClient({ adapter })

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma
    globalForPrisma.prismaDatabaseUrl = databaseUrl
  }
  return prisma
}

export const prisma = getPrismaClient()
