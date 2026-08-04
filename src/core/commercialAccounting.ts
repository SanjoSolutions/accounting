export type PartnerRole = "CUSTOMER" | "SUPPLIER" | "BOTH";
export type DocumentDirection = "RECEIVABLE" | "PAYABLE";
export type CommercialDocumentKind = "INVOICE" | "CREDIT_NOTE";
export type CommercialDocumentStatus = "DRAFT" | "ISSUED";
export type PaymentDirection = "RECEIPT" | "DISBURSEMENT";

export interface BusinessPartner {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly role: PartnerRole;
}

export interface MoneyBreakdown {
  readonly currency: string;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
}

export interface CommercialDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly partnerId: string;
  readonly kind: CommercialDocumentKind;
  readonly direction: DocumentDirection;
  readonly status: CommercialDocumentStatus;
  readonly money: MoneyBreakdown;
  readonly serviceDate: string;
  readonly dueDate: string;
  readonly description: string;
  readonly referenceInvoiceId?: string;
  readonly documentNumber?: string;
  readonly issuedAt?: string;
}

export interface PaymentAllocation {
  readonly documentId: string;
  readonly amountMinor: number;
}

export interface PaymentSettlement {
  readonly id: string;
  readonly tenantId: string;
  readonly partnerId: string;
  readonly direction: PaymentDirection;
  readonly currency: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly allocations: readonly PaymentAllocation[];
}

export interface CreditAllocation {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly creditNoteId: string;
  readonly amountMinor: number;
}

export interface CommercialLedger {
  readonly partners: readonly BusinessPartner[];
  readonly documents: readonly CommercialDocument[];
  readonly payments: readonly PaymentSettlement[];
  readonly creditAllocations: readonly CreditAllocation[];
}

export interface DraftDocumentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly partnerId: string;
  readonly direction: DocumentDirection;
  readonly currency: string;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
  readonly serviceDate: string;
  readonly dueDate: string;
  readonly description: string;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const currencyPattern = /^[A-Z]{3}$/;

export function emptyCommercialLedger(): CommercialLedger {
  return freezeLedger({ partners: [], documents: [], payments: [], creditAllocations: [] });
}

export function addBusinessPartner(
  ledger: CommercialLedger,
  partner: BusinessPartner,
): CommercialLedger {
  requireText(partner.tenantId, "tenantId");
  requireText(partner.id, "partner id");
  requireText(partner.name, "partner name");
  if (findPartner(ledger, partner.tenantId, partner.id)) {
    throw new Error(`Business partner ${partner.id} already exists in tenant ${partner.tenantId}.`);
  }
  return freezeLedger({ ...ledger, partners: [...ledger.partners, freeze({ ...partner })] });
}

export function createInvoiceDraft(
  ledger: CommercialLedger,
  input: DraftDocumentInput,
): CommercialLedger {
  return addDraft(ledger, input, "INVOICE");
}

export function createCreditNoteDraft(
  ledger: CommercialLedger,
  input: DraftDocumentInput & { readonly referenceInvoiceId: string },
): CommercialLedger {
  const invoice = requireDocument(ledger, input.tenantId, input.referenceInvoiceId);
  if (invoice.kind !== "INVOICE" || invoice.status !== "ISSUED") {
    throw new Error("A credit note must reference an issued invoice.");
  }
  if (invoice.partnerId !== input.partnerId || invoice.direction !== input.direction) {
    throw new Error("A credit note must use the referenced invoice's partner and direction.");
  }
  if (invoice.money.currency !== normaliseCurrency(input.currency)) {
    throw new Error("A credit note must use the referenced invoice's currency.");
  }
  if (input.grossMinor > invoice.money.grossMinor) {
    throw new Error("A credit note cannot exceed the referenced invoice.");
  }
  return addDraft(ledger, input, "CREDIT_NOTE", input.referenceInvoiceId);
}

export function reviseDocumentDraft(
  ledger: CommercialLedger,
  tenantId: string,
  documentId: string,
  revision: Pick<DraftDocumentInput, "currency" | "netMinor" | "taxMinor" | "grossMinor" | "serviceDate" | "dueDate" | "description">,
): CommercialLedger {
  const document = requireDocument(ledger, tenantId, documentId);
  if (document.status !== "DRAFT") {
    throw new Error("Issued commercial documents are immutable; issue a credit note instead.");
  }
  const money = makeMoney(revision);
  validateDates(revision.serviceDate, revision.dueDate);
  requireText(revision.description, "description");
  if (document.kind === "CREDIT_NOTE") {
    const invoice = requireDocument(ledger, tenantId, document.referenceInvoiceId!);
    if (money.currency !== invoice.money.currency || money.grossMinor > invoice.money.grossMinor) {
      throw new Error("The revised credit note must retain the invoice currency and cannot exceed it.");
    }
  }
  const revised = freeze({
    ...document,
    money,
    serviceDate: revision.serviceDate,
    dueDate: revision.dueDate,
    description: revision.description.trim(),
  });
  return replaceDocument(ledger, revised);
}

export function issueCommercialDocument(
  ledger: CommercialLedger,
  tenantId: string,
  documentId: string,
  documentNumber: string,
  issuedAt: string,
): CommercialLedger {
  const document = requireDocument(ledger, tenantId, documentId);
  if (document.status !== "DRAFT") throw new Error("The commercial document has already been issued.");
  requireText(documentNumber, "document number");
  requireIsoDate(issuedAt, "issuedAt");
  if (ledger.documents.some(candidate =>
    candidate.tenantId === tenantId && candidate.status === "ISSUED" && candidate.documentNumber === documentNumber.trim()
  )) {
    throw new Error(`Document number ${documentNumber} is already in use in this tenant.`);
  }
  const issued = freeze({
    ...document,
    status: "ISSUED" as const,
    documentNumber: documentNumber.trim(),
    issuedAt,
  });
  return replaceDocument(ledger, issued);
}

export function recordPayment(
  ledger: CommercialLedger,
  payment: Omit<PaymentSettlement, "allocations">,
): CommercialLedger {
  requireText(payment.tenantId, "tenantId");
  requireText(payment.id, "payment id");
  requireIsoDate(payment.occurredOn, "occurredOn");
  const currency = normaliseCurrency(payment.currency);
  requirePositiveMinor(payment.amountMinor, "payment amount");
  const partner = requirePartner(ledger, payment.tenantId, payment.partnerId);
  requirePartnerRole(partner, payment.direction === "RECEIPT" ? "RECEIVABLE" : "PAYABLE");
  if (ledger.payments.some(candidate => candidate.tenantId === payment.tenantId && candidate.id === payment.id)) {
    throw new Error(`Payment ${payment.id} already exists in tenant ${payment.tenantId}.`);
  }
  return freezeLedger({
    ...ledger,
    payments: [...ledger.payments, freeze({ ...payment, currency, allocations: freeze([]) })],
  });
}

export function allocatePayment(
  ledger: CommercialLedger,
  tenantId: string,
  paymentId: string,
  invoiceId: string,
  amountMinor: number,
): CommercialLedger {
  requirePositiveMinor(amountMinor, "allocation amount");
  const payment = requirePayment(ledger, tenantId, paymentId);
  const invoice = requireDocument(ledger, tenantId, invoiceId);
  if (invoice.kind !== "INVOICE" || invoice.status !== "ISSUED") {
    throw new Error("Payments can only be allocated to issued invoices.");
  }
  if (payment.partnerId !== invoice.partnerId) throw new Error("Payment and invoice partners must match.");
  if (payment.currency !== invoice.money.currency) throw new Error("Payment and invoice currencies must match.");
  const expectedDirection: PaymentDirection = invoice.direction === "RECEIVABLE" ? "RECEIPT" : "DISBURSEMENT";
  if (payment.direction !== expectedDirection) throw new Error("Payment and invoice directions must match.");
  if (amountMinor > getUnallocatedPaymentAmount(ledger, tenantId, paymentId)) {
    throw new Error("Allocation exceeds the unallocated payment amount.");
  }
  if (amountMinor > getOpenItemAmount(ledger, tenantId, invoiceId)) {
    throw new Error("Allocation exceeds the invoice's open amount.");
  }
  const updated = freeze({
    ...payment,
    allocations: freeze([...payment.allocations, freeze({ documentId: invoiceId, amountMinor })]),
  });
  return freezeLedger({
    ...ledger,
    payments: ledger.payments.map(candidate => candidate === payment ? updated : candidate),
  });
}

export function allocateCreditNote(
  ledger: CommercialLedger,
  allocation: CreditAllocation,
): CommercialLedger {
  requireText(allocation.id, "credit allocation id");
  requirePositiveMinor(allocation.amountMinor, "credit allocation amount");
  if (ledger.creditAllocations.some(candidate => candidate.tenantId === allocation.tenantId && candidate.id === allocation.id)) {
    throw new Error(`Credit allocation ${allocation.id} already exists in tenant ${allocation.tenantId}.`);
  }
  const invoice = requireDocument(ledger, allocation.tenantId, allocation.invoiceId);
  const credit = requireDocument(ledger, allocation.tenantId, allocation.creditNoteId);
  if (invoice.kind !== "INVOICE" || credit.kind !== "CREDIT_NOTE" ||
      invoice.status !== "ISSUED" || credit.status !== "ISSUED") {
    throw new Error("Credit allocations require an issued invoice and issued credit note.");
  }
  if (credit.referenceInvoiceId !== invoice.id) {
    throw new Error("The credit note does not reference this invoice.");
  }
  if (invoice.partnerId !== credit.partnerId || invoice.direction !== credit.direction ||
      invoice.money.currency !== credit.money.currency) {
    throw new Error("Invoice and credit note scope must match.");
  }
  if (allocation.amountMinor > getOpenItemAmount(ledger, allocation.tenantId, invoice.id)) {
    throw new Error("Credit allocation exceeds the invoice's open amount.");
  }
  if (allocation.amountMinor > getOpenItemAmount(ledger, allocation.tenantId, credit.id)) {
    throw new Error("Credit allocation exceeds the credit note's open amount.");
  }
  return freezeLedger({
    ...ledger,
    creditAllocations: [...ledger.creditAllocations, freeze({ ...allocation })],
  });
}

export function getOpenItemAmount(
  ledger: CommercialLedger,
  tenantId: string,
  documentId: string,
): number {
  const document = requireDocument(ledger, tenantId, documentId);
  if (document.status !== "ISSUED") throw new Error("Draft documents are not open items.");
  const paymentAllocated = document.kind === "INVOICE"
    ? ledger.payments
      .filter(payment => payment.tenantId === tenantId)
      .flatMap(payment => payment.allocations)
      .filter(allocation => allocation.documentId === documentId)
      .reduce((sum, allocation) => checkedAdd(sum, allocation.amountMinor), 0)
    : 0;
  const creditAllocated = ledger.creditAllocations
    .filter(allocation => allocation.tenantId === tenantId &&
      (document.kind === "INVOICE" ? allocation.invoiceId === documentId : allocation.creditNoteId === documentId))
    .reduce((sum, allocation) => checkedAdd(sum, allocation.amountMinor), 0);
  return checkedSubtract(document.money.grossMinor, checkedAdd(paymentAllocated, creditAllocated));
}

/** Positive means the partner owes the tenant; negative means the tenant owes the partner. */
export function getPartnerOpenBalance(
  ledger: CommercialLedger,
  tenantId: string,
  partnerId: string,
  currency: string,
): number {
  requirePartner(ledger, tenantId, partnerId);
  const normalisedCurrency = normaliseCurrency(currency);
  return ledger.documents
    .filter(document => document.tenantId === tenantId && document.partnerId === partnerId &&
      document.status === "ISSUED" && document.money.currency === normalisedCurrency)
    .reduce((balance, document) => {
      const open = getOpenItemAmount(ledger, tenantId, document.id);
      const invoiceSign: 1 | -1 = document.direction === "RECEIVABLE" ? 1 : -1;
      const sign: 1 | -1 = document.kind === "INVOICE" ? invoiceSign : invoiceSign === 1 ? -1 : 1;
      return checkedAdd(balance, checkedMultiplyBySign(open, sign));
    }, 0);
}

export function getUnallocatedPaymentAmount(
  ledger: CommercialLedger,
  tenantId: string,
  paymentId: string,
): number {
  const payment = requirePayment(ledger, tenantId, paymentId);
  const allocated = payment.allocations.reduce(
    (sum, allocation) => checkedAdd(sum, allocation.amountMinor),
    0,
  );
  return checkedSubtract(payment.amountMinor, allocated);
}

function addDraft(
  ledger: CommercialLedger,
  input: DraftDocumentInput,
  kind: CommercialDocumentKind,
  referenceInvoiceId?: string,
): CommercialLedger {
  requireText(input.tenantId, "tenantId");
  requireText(input.id, "document id");
  if (findDocument(ledger, input.tenantId, input.id)) {
    throw new Error(`Commercial document ${input.id} already exists in tenant ${input.tenantId}.`);
  }
  const partner = requirePartner(ledger, input.tenantId, input.partnerId);
  requirePartnerRole(partner, input.direction);
  const money = makeMoney(input);
  validateDates(input.serviceDate, input.dueDate);
  requireText(input.description, "description");
  const document: CommercialDocument = freeze({
    id: input.id,
    tenantId: input.tenantId,
    partnerId: input.partnerId,
    kind,
    direction: input.direction,
    status: "DRAFT",
    money,
    serviceDate: input.serviceDate,
    dueDate: input.dueDate,
    description: input.description.trim(),
    ...(referenceInvoiceId ? { referenceInvoiceId } : {}),
  });
  return freezeLedger({ ...ledger, documents: [...ledger.documents, document] });
}

function makeMoney(input: Pick<DraftDocumentInput, "currency" | "netMinor" | "taxMinor" | "grossMinor">): MoneyBreakdown {
  const currency = normaliseCurrency(input.currency);
  requireNonNegativeMinor(input.netMinor, "net amount");
  requireNonNegativeMinor(input.taxMinor, "tax amount");
  requirePositiveMinor(input.grossMinor, "gross amount");
  if (checkedAdd(input.netMinor, input.taxMinor) !== input.grossMinor) {
    throw new Error("Net amount plus tax amount must equal gross amount.");
  }
  return freeze({ currency, netMinor: input.netMinor, taxMinor: input.taxMinor, grossMinor: input.grossMinor });
}

function replaceDocument(ledger: CommercialLedger, document: CommercialDocument): CommercialLedger {
  return freezeLedger({
    ...ledger,
    documents: ledger.documents.map(candidate => candidate.tenantId === document.tenantId && candidate.id === document.id
      ? document
      : candidate),
  });
}

function requirePartnerRole(partner: BusinessPartner, direction: DocumentDirection): void {
  const required: PartnerRole = direction === "RECEIVABLE" ? "CUSTOMER" : "SUPPLIER";
  if (partner.role !== required && partner.role !== "BOTH") {
    throw new Error(`${direction} documents require a ${required.toLowerCase()} partner.`);
  }
}

function findPartner(ledger: CommercialLedger, tenantId: string, partnerId: string): BusinessPartner | undefined {
  return ledger.partners.find(partner => partner.tenantId === tenantId && partner.id === partnerId);
}

function requirePartner(ledger: CommercialLedger, tenantId: string, partnerId: string): BusinessPartner {
  const partner = findPartner(ledger, tenantId, partnerId);
  if (!partner) throw new Error(`Business partner ${partnerId} does not exist in tenant ${tenantId}.`);
  return partner;
}

function findDocument(ledger: CommercialLedger, tenantId: string, documentId: string): CommercialDocument | undefined {
  return ledger.documents.find(document => document.tenantId === tenantId && document.id === documentId);
}

function requireDocument(ledger: CommercialLedger, tenantId: string, documentId: string): CommercialDocument {
  const document = findDocument(ledger, tenantId, documentId);
  if (!document) throw new Error(`Commercial document ${documentId} does not exist in tenant ${tenantId}.`);
  return document;
}

function requirePayment(ledger: CommercialLedger, tenantId: string, paymentId: string): PaymentSettlement {
  const payment = ledger.payments.find(candidate => candidate.tenantId === tenantId && candidate.id === paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} does not exist in tenant ${tenantId}.`);
  return payment;
}

function validateDates(serviceDate: string, dueDate: string): void {
  requireIsoDate(serviceDate, "serviceDate");
  requireIsoDate(dueDate, "dueDate");
  if (dueDate < serviceDate) throw new Error("Due date cannot precede the service date.");
}

function requireIsoDate(value: string, field: string): void {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!isoDatePattern.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be an ISO calendar date.`);
  }
}

function normaliseCurrency(currency: string): string {
  if (!currencyPattern.test(currency)) throw new Error("Currency must be an uppercase ISO 4217 code.");
  return currency;
}

function requireText(value: string, field: string): void {
  if (!value || !value.trim()) throw new Error(`${field} is required.`);
}

function requireNonNegativeMinor(value: number, field: string): void {
  requireSafeInteger(value, field);
  if (value < 0) throw new Error(`${field} cannot be negative.`);
}

function requirePositiveMinor(value: number, field: string): void {
  requireSafeInteger(value, field);
  if (value <= 0) throw new Error(`${field} must be positive.`);
}

function requireSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer in minor currency units.`);
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("Money arithmetic exceeds the safe-integer range.");
  return result;
}

function checkedSubtract(left: number, right: number): number {
  return checkedAdd(left, -right);
}

function checkedMultiplyBySign(value: number, sign: 1 | -1): number {
  const result = value * sign;
  if (!Number.isSafeInteger(result)) throw new Error("Money arithmetic exceeds the safe-integer range.");
  return result;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function freezeLedger(ledger: CommercialLedger): CommercialLedger {
  return freeze({
    partners: freeze([...ledger.partners]),
    documents: freeze([...ledger.documents]),
    payments: freeze([...ledger.payments]),
    creditAllocations: freeze([...ledger.creditAllocations]),
  });
}
