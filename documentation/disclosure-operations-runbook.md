# Unternehmensregister disclosure qualification

The application can prepare immutable disclosure packages for approved annual
accounts. It must not claim that a package was filed with the
Unternehmensregister until an authorized provider Webservice returns a retained
acceptance receipt.

The Unternehmensregister permits order transmission through the
[Publikations-Plattform or a software Webservice](https://unternehmensregister.de/de/so-gehts/uebermitteln?dest=ureg&language=de).
The provider describes its annual-accounts interface as a mass interface for
XML or XBRL and supplies the workflow and interface specifications on request:
[official interface information](https://publikations-plattform.de/order/de/arbeitshilfenstandards/standards/schnittstellen).
Those provider-controlled specifications, identification and test access are
therefore external qualification inputs, not files that this repository may
guess or replace with a local emulator.

## Qualification gate

The manual `Qualified Unternehmensregister disclosure contract` workflow runs
only in the protected `disclosure-qualification` GitHub environment and only
after the operator confirms authorized TEST/STAGING use. Configure the exact
provider-issued endpoint, schema version, qualification record, electronically
identified submitter and protocol directory in that environment. Keep the
credential and submitter identity in secrets.

The gate executes both supported cases:

1. `MICRO-HINTERLEGUNG`
2. `SMALL-OFFENLEGUNG`

Each case must pass an official validation, reject a package with incomplete
register identity, accept an idempotent non-binding submission, return a
machine-readable TEST/STAGING protocol tied to the exact provider schema and
qualification, and provide a nonblank receipt. Redacted protocols are retained
as workflow artifacts. The same request/key replay must return the same protocol
identity and receipt SHA-256. Non-JSON failures retain status, media type, byte
length, digest and a bounded redacted excerpt before failing closed. A disabled
or skipped contract is not filing evidence.

The provider XML/XBRL layout is intentionally not invented here. Until the
provider-issued specification and credentials are available, the contract's
deterministic disclosure dataset is an adapter-boundary fixture, not proof that
an application-generated annual package has been transformed into the official
wire schema. Qualification must replace or explicitly approve that transformer
against retained application package bytes and the exact provider schema.

Run locally only with an authorized environment:

```powershell
pnpm test:contract:qualified-disclosure
```

Production filing remains disabled until the provider contract has passed and
the resulting qualification identifiers have been approved for deployment.
