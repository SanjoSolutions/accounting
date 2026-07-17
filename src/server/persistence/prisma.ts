import { randomUUID } from 'node:crypto'
import { Address } from '@/core/Address'
import type { BookingRecord } from '@/core/BookingRecord'
import { isChartOfAccountsStandard } from '@/core/ChartOfAccounts'
import { Document } from '@/core/Document'
import { Account } from '@/core/authentication/Account'
import type { PrismaClient } from '@/generated/prisma/client'
import type {
  AccountRepository,
  BookingRecordRepository,
  DocumentRepository,
  Persistence,
} from './Persistence'
import { prisma } from './client'

class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findOne(id: string): Promise<Account | null> {
    const record = await this.prisma.accountRecord.findUnique({ where: { id } })
    if (!record) return null

    const data = JSON.parse(record.payload) as Account
    const account = new Account(data.id)
    account.address = Object.assign(new Address(), data.address)
    account.invoiceIssuer = Object.assign(new Address(), data.invoiceIssuer)
    if (isChartOfAccountsStandard(data.chartOfAccounts)) {
      account.chartOfAccounts = data.chartOfAccounts
    }
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

export function createPrismaPersistence(): Persistence {
  return {
    accounts: new PrismaAccountRepository(prisma),
    documents: new PrismaDocumentRepository(prisma),
    bookingRecords: new PrismaBookingRecordRepository(prisma),
  }
}
