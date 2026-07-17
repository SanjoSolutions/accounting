import type { BookingRecord } from '@/core/BookingRecord'
import type { Document } from '@/core/Document'
import type { Account } from '@/core/authentication/Account'

export interface AccountRepository {
  findOne(id: string): Promise<Account | null>
  save(account: Account): Promise<void>
}

export interface DocumentRepository {
  findOne(id: string): Promise<Document | null>
  findAllByOwner(ownerId: string): Promise<Document[]>
  save(document: Document): Promise<void>
}

export interface BookingRecordRepository {
  save(bookingRecord: BookingRecord): Promise<void>
}

export interface Persistence {
  accounts: AccountRepository
  documents: DocumentRepository
  bookingRecords: BookingRecordRepository
}
