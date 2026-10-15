import 'server-only'
import { prisma } from '@/server/persistence/client'
import { getDocumentStorage } from '@/server/storage'
import { assertCurrentExternalSource, prepareExternalSource } from './source'
import { createExternalEBalanceRepository } from './repository'

export const externalEBalance = createExternalEBalanceRepository({ database: prisma, storage: getDocumentStorage, prepare: prepareExternalSource, assertCurrent: assertCurrentExternalSource })
