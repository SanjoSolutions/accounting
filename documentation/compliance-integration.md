# Compliance and statutory reporting integration

The modules in `src/core/compliance` are deterministic domain services. They deliberately do not read Prisma or HTTP state. The server layer must supply the following tenant-authorized adapters before exposing them through routes or UI:

| Domain | Required adapter | Existing integration point |
| --- | --- | --- |
| Audit/migration export | Load all owner-scoped master data, mapping history, journal/lines, evidence bytes/metadata, VAT facts, audit events and tax submissions; persist every access/export event | `src/server/ledger.ts`, document storage, submission history, a new append-only audit-event repository |
| Procedure documentation | Resolve deployed app/config/schema/taxonomy versions and tenant operator details; retain every approved version and evidence reference | Deployment metadata plus a new tenant procedure-version repository |
| Annual accounts | Resolve authoritative company identity/legal form/size, fiscal-period boundaries and account-to-HGB-line mappings; persist immutable versions, approvals and disclosure receipts | Company settings, `FiscalYear`, ledger balances, a new annual-package repository |
| Fixed assets/inventory | Post approved subledger movements into the journal, attach evidence, persist immutable count snapshots and add reconciliation to fiscal-year close blockers | `postJournalEntry`, documents, `closeFiscalYear` |
| E-Bilanz lifecycle | Replace request-body company fields and calendar-year assumptions with company/period profiles; load official effective-dated taxonomy archives; retain ERiC diagnostics, immutable receipts and supersession links | `prepareEBalance`, taxonomy storage, `runEric`, `EBalanceSubmission` |
| Cash book | Persist append-only entries/daily closes under tenant/location/register keys; post movements and count resolutions to account 1000; include the cash export in the GoBD package | journal posting, audit repository, evidence storage |

VAT integration must provide tax code, tax base, tax amount, return period and submission linkage per journal line. Period integration must support non-calendar fiscal periods and enforce closed-day/year locks. All adapters must authorize with the authenticated tenant ID supplied by the server session; tenant IDs from request bodies are never trusted.

Audit and migration exports must supply authoritative `fiscalYears` rows with inclusive `startDate`/`endDate` boundaries. Every journal references exactly one fiscal year and its booking date must fall within that period. Opening and closing balances are required for every mapped account in every declared fiscal year; each row is identified by `(fiscalYearId, accountId)`, must reconcile to that period's postings and cannot be replaced by a fiscal-year aggregate. Hauptbuch, SuSa and statement drilldown reports retain the fiscal-year identity, start from the declared account opening and expose the reconciled calculated and declared closing balances. Package manifests use format `accounting-audit-package`, version `1`, an explicit-offset ISO creation instant, and a nonblank authority reference for the declared `AUDIT` or `MIGRATION` purpose.

The POS importer only ingests immutable source rows. It is explicitly not a TSE implementation and does not assert §146a AO or KassenSichV compliance.
