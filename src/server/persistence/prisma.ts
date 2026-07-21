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
    const account = new Account(record.id)
    Object.defineProperty(account, 'persistencePayload', { value: record.payload, writable: true, configurable: true, enumerable: false })
    account.address = Object.assign(new Address(), data.address)
    account.invoiceIssuer = Object.assign(new Address(), data.invoiceIssuer)
    if (isChartOfAccountsStandard(data.chartOfAccounts)) {
      account.chartOfAccounts = data.chartOfAccounts
    }
    account.activeChart = account.chartOfAccounts
    if (typeof data.activeChart === 'string' && (isChartOfAccountsStandard(data.activeChart) || /^CUSTOM:.+/.test(data.activeChart))) account.activeChart = data.activeChart
    if (Array.isArray(data.importedCharts) && data.importedCharts.every(item => typeof item === 'string' && /^CUSTOM:.+/.test(item))) account.importedCharts = [...data.importedCharts]
    account.companyProfile = data.companyProfile
    return account
  }

  async claimLegacyDefault(id: string, ownerId: string): Promise<Account | null> {
    const claimed = await this.prisma.$transaction(async transaction => {
      await transaction.$executeRaw`UPDATE AccountRecord SET id = id WHERE id IN ('default', ${id})`
      const existing = await transaction.accountRecord.findUnique({ where: { id } })
      if (existing) return existing
      const legacy = await transaction.accountRecord.findUnique({ where: { id: 'default' } })
      if (!legacy) return null
      const configuredOwner = process.env.LEGACY_SETTINGS_OWNER_ID?.trim()
      if (configuredOwner && configuredOwner !== ownerId) return null
      let unambiguous: boolean
      if (configuredOwner) {
        unambiguous = configuredOwner === 'local' && (process.env.AUTH_MODE ?? 'none') === 'none'
          ? await transaction.user.count() === 0
          : Boolean(await transaction.user.findUnique({ where: { id: configuredOwner }, select: { id: true } }))
      } else {
        const users = await transaction.user.findMany({ select: { id: true }, take: 1 })
        unambiguous = (process.env.AUTH_MODE ?? 'none') === 'none' && ownerId === 'local' && users.length === 0
      }
      if (!unambiguous) throw new Error('Legacy company settings migration is ambiguous. Set LEGACY_SETTINGS_OWNER_ID to the verified tenant id before deployment, start once to claim the record, then remove the variable.')
      const payload = JSON.parse(legacy.payload) as Record<string, unknown>
      payload.id = id
      return transaction.accountRecord.update({ where: { id: 'default' }, data: { id, ownerId, payload: JSON.stringify(payload) } })
    })
    return claimed ? this.findOne(id) : null
  }

  async save(account: Account): Promise<void> {
    const payload = JSON.stringify(account)
    await this.prisma.accountRecord.upsert({
      where: { id: account.id },
      create: { id: account.id, ownerId: account.id.replace(/^company:/, ''), payload },
      update: { payload, ownerId: account.id.replace(/^company:/, '') },
    })
    Object.defineProperty(account, 'persistencePayload', { value: payload, writable: true, configurable: true, enumerable: false })
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

  async findAllByOwner(ownerId: string): Promise<Document[]> {
    const records = await this.prisma.documentRecord.findMany({ where: { ownerId, availableForBooking: true }, orderBy: { id: 'desc' } })
    return records
      .map(record => {
        const data = JSON.parse(record.payload) as Document
        return Object.assign(new Document(data.id, data.url), data)
      })
      .filter(document => document.ownerId === ownerId)
  }

  async save(document: Document): Promise<void> {
    const payload = JSON.stringify(document)
    await this.prisma.documentRecord.upsert({
      where: { id: document.id },
      create: { id: document.id, payload, ownerId: document.ownerId },
      update: { payload, ownerId: document.ownerId },
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
