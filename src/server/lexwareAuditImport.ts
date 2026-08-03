import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { Document } from '@/core/Document'
import { AccountingValidationError } from '@/core/doubleEntry'
import { parseLexwareAuditFiles, type LexwareAuditBooking, type LexwareAuditFile } from '@/core/lexwareAudit'
import { prisma } from './persistence/client'
import { getDocumentStorage } from './storage'
import { appendAuditEvent } from './compliance/auditPersistence'
import { retentionDeadline } from './compliance/retention'

const IMPORT_TRANSACTION_MAX_WAIT_MS = 60_000
const IMPORT_TRANSACTION_TIMEOUT_MS = 15 * 60_000

export async function importLexwareAudit(ownerId: string, files: LexwareAuditFile[]) {
  const parsed = parseLexwareAuditFiles(files)
  const documentImports = [...parsed.documents.entries()].map(([normalizedName, file]) => {
    const contentHash = digestBytes(file.bytes)
    const id = `lexware-${digest(`${ownerId}\0${normalizedName}\0${contentHash}`).slice(0, 32)}`
    const extension = documentExtension(file.name, file.contentType)
    return {
      id,
      normalizedName,
      file,
      contentHash,
      storageKey: `documents/${encodeURIComponent(ownerId)}/${id}.${extension}`,
      storageFileName: `${id}.${extension}`,
    }
  })
  const documentHashes = new Map(documentImports.map(document => [document.normalizedName, document.contentHash]))
  const prepared = parsed.bookings.map(booking => ({
    ...booking,
    externalKey: `LEXWARE_BP:${digest(`${ownerId}\0${booking.year}\0${booking.bookingNumber}`)}`,
    documentHash: booking.documentName ? documentHashes.get(booking.documentName.toLowerCase()) ?? null : null,
  }))
  const storage = getDocumentStorage()
  const createdStorageDocuments: Array<{ id: string; storageKey: string }> = []
  const fiscalYearDefinitions = new Map(parsed.fiscalYears.map(fiscalYear => [fiscalYear.year, fiscalYear]))
  await reconcileStaleDocumentClaims(storage)
  const importId = randomUUID()
  if (documentImports.length > 0) {
    await prisma.documentStorageClaim.createMany({ data: documentImports.map(document => ({
      id: randomUUID(), importId, documentId: document.id, ownerId, storageKey: document.storageKey,
    })) })
  }
  try {
    for (const document of documentImports) {
      if (await storage.exists(document.storageKey)) continue
      await prisma.documentStorageClaim.update({
        where: { importId_documentId: { importId, documentId: document.id } }, data: { createdStorage: true },
      })
      createdStorageDocuments.push(document)
      await storage.writeIfAbsent(document.storageKey, Buffer.from(document.file.bytes), {
        contentType: document.file.contentType, fileName: document.storageFileName,
      })
    }
    const result = await prisma.$transaction(async transaction => {
      const fiscalYears = new Map<number, { id: string; status: string }>()
      for (const year of parsed.years) {
        const definition = fiscalYearDefinitions.get(year)!
        const fiscalYear = await transaction.fiscalYear.upsert({
          where: { ownerId_year: { ownerId, year } },
          create: {
            ownerId, year,
            startsAt: new Date(`${definition.startsAt}T00:00:00.000Z`),
            endsAt: new Date(`${definition.endsAt}T23:59:59.999Z`),
          },
          update: {},
        })
        if (dateOnly(fiscalYear.startsAt) !== definition.startsAt || dateOnly(fiscalYear.endsAt) !== definition.endsAt) {
          throw new AccountingValidationError([`Das vorhandene Geschäftsjahr ${year} hat andere Zeitgrenzen als der Lexware-Export.`])
        }
        await transaction.fiscalYear.updateMany({ where: { id: fiscalYear.id }, data: { updatedAt: new Date() } })
        fiscalYears.set(year, await transaction.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYear.id }, select: { id: true, status: true } }))
      }
      const ownerFiscalYears = await transaction.fiscalYear.findMany({
        where: { ownerId }, select: { year: true, startsAt: true, endsAt: true }, orderBy: { startsAt: 'asc' },
      })
      for (let index = 1; index < ownerFiscalYears.length; index++) {
        const previous = ownerFiscalYears[index - 1]
        const current = ownerFiscalYears[index]
        if (current.startsAt <= previous.endsAt) {
          throw new AccountingValidationError([`Die Geschäftsjahre ${previous.year} und ${current.year} überschneiden sich.`])
        }
      }

      const profile = await transaction.ledgerProfile.upsert({
        where: { ownerId },
        create: { ownerId, chart: parsed.chart, accountLength: parsed.accountLength },
        update: {},
      })
      if (profile.chart !== parsed.chart) {
        throw new AccountingValidationError([`Der Mandant verwendet bereits ${profile.chart}; ein Lexware-Import mit ${parsed.chart} ist nicht möglich.`])
      }
      if (profile.accountLength && profile.accountLength !== parsed.accountLength) {
        throw new AccountingValidationError(['Die Sachkontenlänge passt nicht zu früheren Importen dieses Mandanten.'])
      }
      if (!profile.accountLength) await transaction.ledgerProfile.update({ where: { ownerId }, data: { accountLength: parsed.accountLength } })

      for (const setup of parsed.companySetup) {
        const data = {
          companyName: setup.companyName,
          street: setup.street,
          postalCode: setup.postalCode,
          city: setup.city,
          region: setup.region,
          phone: setup.phone,
          fax: setup.fax,
          currency: setup.currency,
          accountingMethod: setup.accountingMethod,
          chart: setup.chart,
          startsAt: new Date(`${setup.fiscalYear.startsAt}T00:00:00.000Z`),
          endsAt: new Date(`${setup.fiscalYear.endsAt}T23:59:59.999Z`),
          taxonomyVersion: setup.taxonomyVersion,
        }
        await transaction.lexwareCompanySetup.upsert({
          where: { ownerId_year: { ownerId, year: setup.year } },
          create: { ownerId, year: setup.year, ...data },
          update: data,
        })
      }
      for (const account of parsed.accounts) {
        for (const metadata of account.metadata) {
          const { year, ...data } = metadata
          await transaction.lexwareAccountMetadata.upsert({
            where: { ownerId_year_accountNumber: { ownerId, year, accountNumber: account.number } },
            create: { ownerId, year, accountNumber: account.number, ...data },
            update: data,
          })
        }
      }
      for (const line of parsed.trialBalance) {
        const { year, accountNumber, lastBookingDate, ...amounts } = line
        const data = {
          ...amounts,
          lastBookingDate: lastBookingDate ? new Date(`${lastBookingDate}T12:00:00.000Z`) : null,
        }
        await transaction.lexwareTrialBalanceLine.upsert({
          where: { ownerId_year_accountNumber: { ownerId, year, accountNumber } },
          create: { ownerId, year, accountNumber, ...data },
          update: data,
        })
      }
      for (const partner of parsed.businessPartners) {
        const { year, partnerNumber, ...data } = partner
        await transaction.lexwareBusinessPartner.upsert({
          where: { ownerId_year_partnerNumber: { ownerId, year, partnerNumber } },
          create: { ownerId, year, partnerNumber, ...data },
          update: data,
        })
      }
      for (const association of parsed.subledgerAssociations) {
        await transaction.lexwareSubledgerAssociation.upsert({
          where: {
            ownerId_year_accountNumber_partnerNumber_kind: {
              ownerId,
              year: association.year,
              accountNumber: association.accountNumber,
              partnerNumber: association.partnerNumber,
              kind: association.kind,
            },
          },
          create: { ownerId, ...association },
          update: {},
        })
      }
      for (const field of parsed.annualVatFields) {
        await transaction.lexwareAnnualVatField.upsert({
          where: { ownerId_year_fieldCode: { ownerId, year: field.year, fieldCode: field.fieldCode } },
          create: { ownerId, ...field },
          update: { amountCents: field.amountCents },
        })
      }

      const existingEntries = await transaction.journalEntry.findMany({
        where: { externalKey: { in: prepared.map(booking => booking.externalKey) } },
        select: {
          externalKey: true, bookingDate: true, sourcePostingDate: true, sourceJournalDate: true, sourcePeriod: true,
          documentNumber: true, description: true,
          lines: { select: { debitCents: true, creditCents: true, taxCode: true, taxRateBasisPoints: true, account: { select: { number: true } } } },
          documents: { select: { document: { select: { payload: true } } } },
        },
      })
      const existing = new Map(existingEntries.flatMap(entry => entry.externalKey ? [[entry.externalKey, entry] as const] : []))
      for (const booking of prepared) {
        const stored = existing.get(booking.externalKey)
        if (stored && storedFingerprint(stored) !== importedFingerprint(booking)) {
          throw new AccountingValidationError([`Die bereits importierte Lexware-Buchung ${booking.bookingNumber}/${booking.year} hat abweichende Buchungsdaten.`])
        }
      }
      const pending = prepared.filter(booking => !existing.has(booking.externalKey))
      const pendingYears = new Set(pending.map(booking => booking.year))
      for (const year of parsed.years.filter(year => pendingYears.has(year))) {
        if (fiscalYears.get(year)?.status !== 'OPEN') throw new AccountingValidationError([`Das Geschäftsjahr ${year} ist gesperrt.`])
        const closedSuccessor = await transaction.fiscalYear.findFirst({
          where: { ownerId, year: { gt: year }, status: 'CLOSED' }, select: { year: true }, orderBy: { year: 'asc' },
        })
        if (closedSuccessor) throw new AccountingValidationError([`In ${year} kann nicht mehr importiert werden, weil das Folgejahr ${closedSuccessor.year} bereits abgeschlossen ist.`])
      }

      for (const account of parsed.accounts) {
        await transaction.ledgerAccount.upsert({
          where: { ownerId_number: { ownerId, number: account.number } },
          create: { ownerId, number: account.number, name: account.name, category: account.category, eBilanzPosition: null },
          update: { name: account.name },
        })
      }
      const accountRows = await transaction.ledgerAccount.findMany({
        where: { ownerId, number: { in: parsed.accounts.map(account => account.number) }, active: true },
        select: { id: true, number: true, category: true },
      })
      const expectedCategories = new Map(parsed.accounts.map(account => [account.number, account.category]))
      const conflict = accountRows.find(account => account.category !== expectedCategories.get(account.number))
      if (conflict) throw new AccountingValidationError([`Konto ${conflict.number} ist bereits mit der Kategorie ${conflict.category} angelegt und passt nicht zum Lexware-Kontenplan.`])
      const accountIds = new Map(accountRows.map(account => [account.number, account.id]))
      if (accountIds.size !== parsed.accounts.length) throw new AccountingValidationError(['Mindestens ein Lexware-Konto ist inaktiv und kann nicht bebucht werden.'])

      const documentIds = new Map<string, string>()
      for (const imported of documentImports) {
        const document = new Document(
          imported.id,
          `/api/documents/${imported.id}/file`,
          imported.storageKey,
          imported.file.name,
          imported.file.contentType,
          imported.file.bytes.length,
          ownerId,
        )
        await transaction.documentRecord.upsert({
          where: { id: imported.id },
          create: { id: imported.id, payload: JSON.stringify({ ...document, sourceHash: imported.contentHash }), ownerId },
          update: {},
        })
        const definition = prepared
          .filter(item => item.documentName?.toLowerCase() === imported.normalizedName)
          .map(item => fiscalYearDefinitions.get(item.year))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .sort((left, right) => right.endsAt.localeCompare(left.endsAt))[0]
        const fallbackPeriodEnd = `${new Date().getUTCFullYear() + 1}-12-31`
        const periodEnd = definition?.endsAt ?? fallbackPeriodEnd
        const deadline = retentionDeadline('INVOICE', periodEnd)
        const artifactKey = { ownerId, objectType: 'Document', objectId: imported.id, version: 1 }
        const retained = await transaction.retainedArtifact.findUnique({ where: { ownerId_objectType_objectId_version: artifactKey } })
        const periodEndsAt = new Date(`${periodEnd}T23:59:59.999Z`)
        const retainUntil = new Date(`${deadline.retainUntil}T23:59:59.999Z`)
        const extend = retained && (periodEndsAt > retained.periodEndsAt || retainUntil > retained.retainUntil)
        await transaction.retainedArtifact.upsert({
          where: { ownerId_objectType_objectId_version: artifactKey },
          create: { ...artifactKey, retentionClass: 'INVOICE', contentHash: imported.contentHash, provenance: 'Lexware Betriebsprüfung import', storageKey: imported.storageKey, periodEndsAt, retainUntil },
          update: extend ? { periodEndsAt: periodEndsAt > retained.periodEndsAt ? periodEndsAt : retained.periodEndsAt, retainUntil: retainUntil > retained.retainUntil ? retainUntil : retained.retainUntil } : {},
        })
        documentIds.set(imported.normalizedName, imported.id)
      }

      let importedCount = 0
      for (const year of parsed.years) {
        const fiscalYear = fiscalYears.get(year)!
        let sequenceNumber = (await transaction.journalEntry.findFirst({
          where: { fiscalYearId: fiscalYear.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true },
        }))?.sequenceNumber ?? 0
        for (const booking of pending.filter(item => item.year === year).sort((left, right) => left.bookingNumber - right.bookingNumber)) {
          sequenceNumber++
          const attachedDocumentId = booking.documentName ? documentIds.get(booking.documentName.toLowerCase()) : undefined
          await transaction.journalEntry.create({ data: {
            fiscalYearId: fiscalYear.id,
            sequenceNumber,
            bookingDate: new Date(`${booking.bookingDate}T12:00:00.000Z`),
            sourcePostingDate: new Date(`${booking.postingDate}T12:00:00.000Z`),
            sourceJournalDate: new Date(`${booking.journalDate}T12:00:00.000Z`),
            sourcePeriod: booking.period,
            documentNumber: persistedDocumentNumber(booking),
            description: booking.description,
            source: 'LEXWARE_BP',
            externalKey: booking.externalKey,
            lines: { create: booking.lines.map(line => ({
              accountId: accountIds.get(line.accountNumber)!,
              debitCents: line.debitCents,
              creditCents: line.creditCents,
              taxCode: line.isVatLine ? 'LEXWARE_VAT_LINE'
                : line.vatAccountNumber ? `LEXWARE_VAT_ACCOUNT:${line.vatAccountNumber}` : null,
              taxRateBasisPoints: line.vatRateBasisPoints ?? null,
            })) },
            ...(attachedDocumentId ? { documents: { create: [{ documentId: attachedDocumentId }] } } : {}),
          } })
          importedCount++
        }
      }
      const result = {
        format: 'LEXWARE_BP' as const,
        imported: importedCount,
        skipped: parsed.bookings.length - importedCount,
        accounts: parsed.accounts.length,
        documents: documentImports.length,
        years: parsed.years,
        trialBalanceLines: parsed.trialBalance.length,
        businessPartners: parsed.businessPartners.length,
        annualVatFields: parsed.annualVatFields.length,
      }
      await appendAuditEvent(transaction, { ownerId, actorId: ownerId, action: 'LEXWARE_IMPORT_COMPLETED', reason: 'Authenticated Lexware Betriebsprüfung import', objectType: 'AccountingImport', objectId: `LEXWARE_BP:${importId}`, after: result })
      return result
    }, { maxWait: IMPORT_TRANSACTION_MAX_WAIT_MS, timeout: IMPORT_TRANSACTION_TIMEOUT_MS })
    await prisma.documentStorageClaim.deleteMany({ where: { importId } }).catch(() => undefined)
    return result
  } catch (error) {
    await releaseDocumentClaims(importId, documentImports, createdStorageDocuments, storage)
    throw error
  }
}

function documentExtension(fileName: string, contentType: string) {
  const typeExtensions: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
  }
  return typeExtensions[contentType.toLowerCase()]
    ?? fileName.match(/\.([a-z0-9]{1,10})$/i)?.[1].toLowerCase()
    ?? 'bin'
}

async function reconcileStaleDocumentClaims(storage: ReturnType<typeof getDocumentStorage>) {
  const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const staleClaims = await prisma.documentStorageClaim.findMany({
    where: { createdAt: { lt: staleBefore } },
    select: { importId: true, documentId: true, storageKey: true },
  }).catch(() => [])
  const importIds = [...new Set(staleClaims.map(claim => claim.importId))]
  for (const importId of importIds) {
    const documents = staleClaims.filter(claim => claim.importId === importId).map(claim => ({ id: claim.documentId, storageKey: claim.storageKey }))
    await releaseDocumentClaims(importId, documents, [], storage)
  }
}

async function releaseDocumentClaims(
  importId: string,
  documents: Array<{ id: string; storageKey: string }>,
  locallyCreated: Array<{ id: string }>,
  storage: ReturnType<typeof getDocumentStorage>,
) {
  await prisma.$transaction(async transaction => {
    const documentIds = documents.map(document => document.id)
    const ownClaims = await transaction.documentStorageClaim.findMany({
      where: { importId }, select: { documentId: true, createdStorage: true },
    })
    const createdDocumentIds = new Set([
      ...ownClaims.filter(claim => claim.createdStorage).map(claim => claim.documentId),
      ...locallyCreated.map(document => document.id),
    ])
    await transaction.documentStorageClaim.deleteMany({ where: { importId } })
    const [remainingClaims, committedDocuments] = await Promise.all([
      transaction.documentStorageClaim.findMany({
        where: { documentId: { in: documentIds } }, select: { documentId: true },
      }),
      transaction.documentRecord.findMany({ where: { id: { in: documentIds } }, select: { id: true } }),
    ])
    const remainingDocumentIds = new Set(remainingClaims.map(claim => claim.documentId))
    const committedDocumentIds = new Set(committedDocuments.map(document => document.id))
    const transferDocumentIds = [...createdDocumentIds].filter(documentId => remainingDocumentIds.has(documentId))
    if (transferDocumentIds.length > 0) {
      await transaction.documentStorageClaim.updateMany({
        where: { documentId: { in: transferDocumentIds } }, data: { createdStorage: true },
      })
    }
    const storageKeysToDelete = documents.filter(document =>
      createdDocumentIds.has(document.id) && !remainingDocumentIds.has(document.id) && !committedDocumentIds.has(document.id),
    ).map(document => document.storageKey)
    for (let offset = 0; offset < storageKeysToDelete.length; offset += 64) {
      await Promise.all(storageKeysToDelete.slice(offset, offset + 64).map(storageKey => storage.delete(storageKey)))
    }
  }, { maxWait: IMPORT_TRANSACTION_MAX_WAIT_MS, timeout: IMPORT_TRANSACTION_TIMEOUT_MS }).catch(() => undefined)
}

function persistedDocumentNumber(booking: LexwareAuditBooking) {
  const label = booking.documentNumber.trim().replace(/\s+/g, '-').slice(0, 40) || 'OHNE-BELEGNUMMER'
  const sourceDigest = digest(booking.documentNumber).slice(0, 10)
  return `LEXWARE-${label}-${sourceDigest}-${booking.year}-${booking.bookingNumber}`
}

function importedFingerprint(booking: LexwareAuditBooking & { documentHash: string | null }) {
  return fingerprint(
    booking.bookingDate,
    booking.postingDate,
    booking.journalDate,
    booking.period,
    persistedDocumentNumber(booking),
    booking.description,
    booking.lines,
    booking.documentName,
    booking.documentHash,
  )
}

function storedFingerprint(entry: {
  bookingDate: Date
  sourcePostingDate: Date | null
  sourceJournalDate: Date | null
  sourcePeriod: number | null
  documentNumber: string
  description: string
  lines: Array<{ debitCents: number; creditCents: number; taxCode: string | null; taxRateBasisPoints: number | null; account: { number: number } }>
  documents: Array<{ document: { payload: string } }>
}) {
  const documents = entry.documents.flatMap(attachment => {
    try {
      const payload = JSON.parse(attachment.document.payload) as { fileName?: string; sourceHash?: string }
      return [{ name: payload.fileName ?? null, hash: payload.sourceHash ?? null }]
    } catch { return [{ name: null, hash: null }] }
  })
  return fingerprint(
    entry.bookingDate.toISOString().slice(0, 10),
    entry.sourcePostingDate?.toISOString().slice(0, 10) ?? null,
    entry.sourceJournalDate?.toISOString().slice(0, 10) ?? null,
    entry.sourcePeriod,
    entry.documentNumber,
    entry.description,
    entry.lines.map(line => ({
      accountNumber: line.account.number,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      ...(line.taxCode === 'LEXWARE_VAT_LINE' ? { isVatLine: true as const } : {}),
      ...(line.taxCode?.startsWith('LEXWARE_VAT_ACCOUNT:') ? {
        vatAccountNumber: Number(line.taxCode.slice('LEXWARE_VAT_ACCOUNT:'.length)),
        vatRateBasisPoints: line.taxRateBasisPoints ?? undefined,
      } : {}),
    })),
    documents[0]?.name ?? null,
    documents[0]?.hash ?? null,
  )
}

function fingerprint(
  bookingDate: string,
  postingDate: string | null,
  journalDate: string | null,
  period: number | null,
  documentNumber: string,
  description: string,
  lines: Array<{
    accountNumber: number
    debitCents: number
    creditCents: number
    vatAccountNumber?: number
    vatRateBasisPoints?: number
    isVatLine?: true
  }>,
  documentName: string | null,
  documentHash: string | null,
) {
  return JSON.stringify({
    bookingDate, postingDate, journalDate, period, documentNumber, description,
    lines: [...lines].sort((left, right) => left.accountNumber - right.accountNumber || left.debitCents - right.debitCents || left.creditCents - right.creditCents),
    documentName: documentName?.toLowerCase() ?? null,
    documentHash,
  })
}

function digest(value: string) { return createHash('sha256').update(value).digest('hex') }
function digestBytes(value: Uint8Array) { return createHash('sha256').update(value).digest('hex') }
function dateOnly(value: Date) { return value.toISOString().slice(0, 10) }
