# Document search

Issue #24 adds filename and content search to the booking document picker. All
query words must match the filename or indexed content. Matching ignores case,
combining accents and German sharp s. Filename matches rank before content-only
matches; results include a bounded plain-text excerpt. Filtering does not alter
attachments. Results are paginated in groups of 50.

Apply the additive `20261015100000_document_search` migration with the normal
guarded deployment process. No original files, posting availability or invoice
extraction records are changed. Existing files are immediately searchable by
name. Use **Update content search** to index or retry up to 20 incomplete files
at a time. New uploads schedule indexing after the successful upload response.
The authenticated POST endpoint also supports indexing individual legacy files.

PDF.js extracts all text-layer pages; XML is parsed without DTDs or external
entities. Each textless PDF page can be rendered and recognized locally by
Tesseract. Configure `DOCUMENT_SEARCH_OCR_COMMAND` to an installed Tesseract
executable and `DOCUMENT_SEARCH_OCR_LANGUAGES` to installed languages (default
`deu+eng`). No cloud OCR account or document transfer is used. Without OCR,
textless documents show **Scan needs OCR setup** and mixed PDFs show a partial
index while retaining readable text. After setup, retry incomplete indexes.
OCR can misread characters; indexed content is only a search aid, never an
authoritative invoice fact or a posting input.

Indexing runs in an isolated Node worker with a 256 MiB JavaScript heap limit,
60-second total timeout, one active worker per app process, 100 pages, 20 MiB
input and 500,000 text characters. Each Tesseract process has a 15-second timeout
and a bounded output buffer. Interrupted jobs can be reclaimed after a 90-second
lease; attempt identities fence late workers. Busy/failed jobs remain retryable.
Parser diagnostics and subprocess output are not exposed to clients.

The derived index has a composite tenant/document foreign key and is included
in tenant backups. GET search is read-only and uses the authenticated tenant.
The default scope respects `availableForBooking`; explicit `scope=all` supports
archive callers without changing document lifecycle rules owned by #23.
Index mutations require write permission. No full text or storage locator is
returned. Search uses a tenant-scoped substring scan, appropriate to the current
document library; it is not a ranked FTS engine for large archives.

API: `GET /api/documents/search?q=...&offset=0&scope=available` and
`POST /api/documents/:id/search-index`. Search state and its lease are independent
of the invoice extraction/confirmation lifecycle owned by #48.

Verification uses synthetic PDFs, disposable databases and isolated storage.
`playwright.document-search.config.ts` owns port 3224 and refuses server reuse.
Set `DOCUMENT_SEARCH_TEST_OCR_COMMAND` to the local Tesseract executable before
running the focused OCR tests or this Playwright config. The default unit suite
also covers missing OCR, malformed input, XML restrictions, retry/fencing,
tenant isolation, relevance and pagination without requiring Tesseract.

References: [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html),
[Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html).
