import { randomUUID } from 'node:crypto'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { Address } from '@/core/Address'
import type { BookingRecord } from '@/core/BookingRecord'
import { Document } from '@/core/Document'
import { Account } from '@/core/authentication/Account'
import { PrismaClient } from '@/generated/prisma/client'
import type {
  AccountRepository,
  BookingRecordRepository,
  DocumentRepository,
  Persistence,
} from './Persistence'

class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOne(id: string): Promise<Account | null> {
    const record = await this.prisma.accountRecord.findUnique({ where: { id } })
    if (!record) return null

    const data = JSON.parse(record.payload) as Account
    const account = new Account(data.id)
    account.address = Object.assign(new Address(), data.address)
    account.invoiceIssuer = Object.assign(new Address(), data.invoiceIssuer)
    return account
  }

  async save(account: Account): Promise<void> {
    const payload = JSON.stringify(account)
    await this.prisma.accountRecord.upsert({
      where: { id: account.id },
      create: { id: account.id, payload },
      update: { payload },
    })
  }
}

class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOne(id: string): Promise<Document | null> {
    const record = await this.prisma.documentRecord.findUnique({ where: { id } })
    if (!record) return null

    const data = JSON.parse(record.payload) as Document
    return Object.assign(new Document(data.id, data.url), data)
  }

  async save(document: Document): Promise<void> {
    const payload = JSON.stringify(document)
    await this.prisma.documentRecord.upsert({
      where: { id: document.id },
      create: { id: document.id, payload },
      update: { payload },
    })
  }
}

class PrismaBookingRecordRepository implements BookingRecordRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(bookingRecord: BookingRecord): Promise<void> {
    await this.prisma.bookingRecordEntry.create({
      data: { id: randomUUID(), payload: JSON.stringify(bookingRecord) },
    })
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function getPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma

  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? 'file:./accounting.db',
  })
  const prisma = new PrismaClient({ adapter })

  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
  return prisma
}

export function createPrismaPersistence(): Persistence {
  const prisma = getPrismaClient()
  return {
    accounts: new PrismaAccountRepository(prisma),
    documents: new PrismaDocumentRepository(prisma),
    bookingRecords: new PrismaBookingRecordRepository(prisma),
  }
}
