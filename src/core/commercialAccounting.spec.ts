import { describe, expect, it } from "vitest";
import {
  addBusinessPartner,
  allocateCreditNote,
  allocatePayment,
  createCreditNoteDraft,
  createInvoiceDraft,
  emptyCommercialLedger,
  getOpenItemAmount,
  getPartnerOpenBalance,
  getUnallocatedPaymentAmount,
  issueCommercialDocument,
  recordPayment,
  reviseDocumentDraft,
  type CommercialLedger,
  type DraftDocumentInput,
} from "./commercialAccounting";

const invoiceInput: DraftDocumentInput = {
  id: "invoice-1",
  tenantId: "tenant-a",
  partnerId: "customer-1",
  direction: "RECEIVABLE",
  currency: "EUR",
  netMinor: 10_000,
  taxMinor: 1_900,
  grossMinor: 11_900,
  serviceDate: "2026-08-01",
  dueDate: "2026-08-15",
  description: "Consulting services",
};

function ledgerWithCustomer(): CommercialLedger {
  return addBusinessPartner(emptyCommercialLedger(), {
    id: "customer-1",
    tenantId: "tenant-a",
    name: "Musterkunde GmbH",
    role: "CUSTOMER",
  });
}

function ledgerWithIssuedInvoice(): CommercialLedger {
  return issueCommercialDocument(
    createInvoiceDraft(ledgerWithCustomer(), invoiceInput),
    "tenant-a",
    "invoice-1",
    "RE-2026-0001",
    "2026-08-01",
  );
}

describe("commercial invoice lifecycle", () => {
  it("Given a tenant customer, when an invoice is issued, then it becomes an open receivable", () => {
    const ledger = ledgerWithIssuedInvoice();

    expect(ledger.documents[0]).toMatchObject({ status: "ISSUED", documentNumber: "RE-2026-0001" });
    expect(getOpenItemAmount(ledger, "tenant-a", "invoice-1")).toBe(11_900);
    expect(getPartnerOpenBalance(ledger, "tenant-a", "customer-1", "EUR")).toBe(11_900);
  });

  it("Given an invoice draft, when it is revised, then the old ledger remains unchanged", () => {
    const original = createInvoiceDraft(ledgerWithCustomer(), invoiceInput);
    const revised = reviseDocumentDraft(original, "tenant-a", "invoice-1", {
      currency: "EUR",
      netMinor: 20_000,
      taxMinor: 3_800,
      grossMinor: 23_800,
      serviceDate: "2026-08-02",
      dueDate: "2026-08-20",
      description: "Revised services",
    });

    expect(original.documents[0].money.grossMinor).toBe(11_900);
    expect(revised.documents[0].money.grossMinor).toBe(23_800);
    expect(revised).not.toBe(original);
    expect(Object.isFrozen(revised.documents)).toBe(true);
  });

  it("Given an issued invoice, when revision or repeated issue is attempted, then it stays immutable", () => {
    const ledger = ledgerWithIssuedInvoice();

    expect(() => reviseDocumentDraft(ledger, "tenant-a", "invoice-1", {
      currency: "EUR", netMinor: 1, taxMinor: 0, grossMinor: 1,
      serviceDate: "2026-08-01", dueDate: "2026-08-15", description: "Changed",
    })).toThrow(/immutable/);
    expect(() => issueCommercialDocument(ledger, "tenant-a", "invoice-1", "RE-2", "2026-08-02"))
      .toThrow(/already been issued/);
  });

  it("Given existing tenant numbering, when a duplicate is issued in that tenant, then it is rejected", () => {
    const ledger = createInvoiceDraft(ledgerWithIssuedInvoice(), { ...invoiceInput, id: "invoice-2" });
    expect(() => issueCommercialDocument(ledger, "tenant-a", "invoice-2", "RE-2026-0001", "2026-08-02"))
      .toThrow(/already in use/);
  });
});

describe("payment settlement allocations", () => {
  it("Given an open invoice and receipt, when partially allocated, then both residuals are retained", () => {
    const withPayment = recordPayment(ledgerWithIssuedInvoice(), {
      id: "payment-1", tenantId: "tenant-a", partnerId: "customer-1",
      direction: "RECEIPT", currency: "EUR", amountMinor: 11_900, occurredOn: "2026-08-10",
    });
    const allocated = allocatePayment(withPayment, "tenant-a", "payment-1", "invoice-1", 5_000);

    expect(getOpenItemAmount(allocated, "tenant-a", "invoice-1")).toBe(6_900);
    expect(getUnallocatedPaymentAmount(allocated, "tenant-a", "payment-1")).toBe(6_900);
    expect(getPartnerOpenBalance(allocated, "tenant-a", "customer-1", "EUR")).toBe(6_900);
  });

  it("Given a partially settled invoice, when the remainder is allocated, then it is fully settled", () => {
    let ledger = recordPayment(ledgerWithIssuedInvoice(), {
      id: "payment-1", tenantId: "tenant-a", partnerId: "customer-1",
      direction: "RECEIPT", currency: "EUR", amountMinor: 11_900, occurredOn: "2026-08-10",
    });
    ledger = allocatePayment(ledger, "tenant-a", "payment-1", "invoice-1", 5_000);
    ledger = allocatePayment(ledger, "tenant-a", "payment-1", "invoice-1", 6_900);

    expect(getOpenItemAmount(ledger, "tenant-a", "invoice-1")).toBe(0);
    expect(getUnallocatedPaymentAmount(ledger, "tenant-a", "payment-1")).toBe(0);
  });

  it("Given insufficient invoice or payment residuals, when over-allocation is attempted, then it is rejected", () => {
    const smallPayment = recordPayment(ledgerWithIssuedInvoice(), {
      id: "payment-1", tenantId: "tenant-a", partnerId: "customer-1",
      direction: "RECEIPT", currency: "EUR", amountMinor: 5_000, occurredOn: "2026-08-10",
    });
    expect(() => allocatePayment(smallPayment, "tenant-a", "payment-1", "invoice-1", 5_001))
      .toThrow(/unallocated payment/);

    const largePayment = recordPayment(ledgerWithIssuedInvoice(), {
      id: "payment-2", tenantId: "tenant-a", partnerId: "customer-1",
      direction: "RECEIPT", currency: "EUR", amountMinor: 20_000, occurredOn: "2026-08-10",
    });
    expect(() => allocatePayment(largePayment, "tenant-a", "payment-2", "invoice-1", 11_901))
      .toThrow(/open amount/);
  });
});

describe("credit notes", () => {
  function ledgerWithIssuedCredit(): CommercialLedger {
    const draft = createCreditNoteDraft(ledgerWithIssuedInvoice(), {
      ...invoiceInput,
      id: "credit-1",
      netMinor: 2_000,
      taxMinor: 380,
      grossMinor: 2_380,
      description: "Partial correction",
      referenceInvoiceId: "invoice-1",
    });
    return issueCommercialDocument(draft, "tenant-a", "credit-1", "GS-2026-0001", "2026-08-03");
  }

  it("Given an issued invoice, when a partial credit note is issued and allocated, then both open items close proportionally", () => {
    const ledger = allocateCreditNote(ledgerWithIssuedCredit(), {
      id: "credit-allocation-1", tenantId: "tenant-a", invoiceId: "invoice-1",
      creditNoteId: "credit-1", amountMinor: 2_380,
    });

    expect(getOpenItemAmount(ledger, "tenant-a", "invoice-1")).toBe(9_520);
    expect(getOpenItemAmount(ledger, "tenant-a", "credit-1")).toBe(0);
    expect(getPartnerOpenBalance(ledger, "tenant-a", "customer-1", "EUR")).toBe(9_520);
  });

  it("Given an unallocated credit note, when partner balance is requested, then it reduces the receivable", () => {
    const ledger = ledgerWithIssuedCredit();
    expect(getPartnerOpenBalance(ledger, "tenant-a", "customer-1", "EUR")).toBe(9_520);
  });

  it("Given a credit note, when it references another tenant or exceeds its invoice, then it is rejected", () => {
    expect(() => createCreditNoteDraft(ledgerWithIssuedInvoice(), {
      ...invoiceInput, id: "credit-1", grossMinor: 11_901, netMinor: 10_001,
      referenceInvoiceId: "invoice-1",
    })).toThrow(/cannot exceed/);
    expect(() => createCreditNoteDraft(ledgerWithIssuedInvoice(), {
      ...invoiceInput, id: "credit-1", tenantId: "tenant-b", referenceInvoiceId: "invoice-1",
    })).toThrow(/does not exist in tenant tenant-b/);
  });
});

describe("commercial scope and monetary invariants", () => {
  it("Given tenant-scoped identifiers, when another tenant uses the same ids, then records remain isolated", () => {
    let ledger = ledgerWithIssuedInvoice();
    ledger = addBusinessPartner(ledger, { id: "customer-1", tenantId: "tenant-b", name: "Other", role: "CUSTOMER" });
    ledger = createInvoiceDraft(ledger, { ...invoiceInput, tenantId: "tenant-b" });
    ledger = issueCommercialDocument(ledger, "tenant-b", "invoice-1", "RE-2026-0001", "2026-08-01");

    expect(getOpenItemAmount(ledger, "tenant-a", "invoice-1")).toBe(11_900);
    expect(getOpenItemAmount(ledger, "tenant-b", "invoice-1")).toBe(11_900);
    expect(ledger.documents).toHaveLength(2);
  });

  it("Given cross-tenant, cross-currency, cross-partner, or wrong-direction payment data, when allocated, then it is rejected", () => {
    let ledger = ledgerWithIssuedInvoice();
    ledger = addBusinessPartner(ledger, { id: "customer-2", tenantId: "tenant-a", name: "Other", role: "CUSTOMER" });
    ledger = recordPayment(ledger, {
      id: "usd", tenantId: "tenant-a", partnerId: "customer-1", direction: "RECEIPT",
      currency: "USD", amountMinor: 11_900, occurredOn: "2026-08-10",
    });
    ledger = recordPayment(ledger, {
      id: "other", tenantId: "tenant-a", partnerId: "customer-2", direction: "RECEIPT",
      currency: "EUR", amountMinor: 11_900, occurredOn: "2026-08-10",
    });
    expect(() => allocatePayment(ledger, "tenant-a", "usd", "invoice-1", 1)).toThrow(/currencies/);
    expect(() => allocatePayment(ledger, "tenant-a", "other", "invoice-1", 1)).toThrow(/partners/);
    expect(() => allocatePayment(ledger, "tenant-b", "usd", "invoice-1", 1)).toThrow(/does not exist/);
  });

  it("Given a supplier-only partner, when a receivable is drafted, then role misuse is rejected", () => {
    const ledger = addBusinessPartner(emptyCommercialLedger(), {
      id: "supplier-1", tenantId: "tenant-a", name: "Lieferant GmbH", role: "SUPPLIER",
    });
    expect(() => createInvoiceDraft(ledger, { ...invoiceInput, partnerId: "supplier-1" }))
      .toThrow(/customer partner/);
  });

  it("Given invalid currency or inconsistent minor-unit amounts, when a draft is created, then it is rejected", () => {
    expect(() => createInvoiceDraft(ledgerWithCustomer(), { ...invoiceInput, currency: "eur" }))
      .toThrow(/uppercase ISO 4217/);
    expect(() => createInvoiceDraft(ledgerWithCustomer(), { ...invoiceInput, grossMinor: 11_901 }))
      .toThrow(/must equal gross/);
    expect(() => createInvoiceDraft(ledgerWithCustomer(), { ...invoiceInput, taxMinor: 0.5, grossMinor: 10_000.5 }))
      .toThrow(/safe integer/);
    expect(() => createInvoiceDraft(ledgerWithCustomer(), { ...invoiceInput, dueDate: "2026-02-31" }))
      .toThrow(/ISO calendar date/);
  });

  it("Given amounts near the safe-integer boundary, when arithmetic would overflow, then it fails closed", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const ledger = createInvoiceDraft(ledgerWithCustomer(), {
      ...invoiceInput, netMinor: max, taxMinor: 0, grossMinor: max,
    });
    expect(ledger.documents[0].money.grossMinor).toBe(max);

    expect(() => createInvoiceDraft(ledgerWithCustomer(), {
      ...invoiceInput, netMinor: max, taxMinor: 1, grossMinor: max,
    })).toThrow(/safe-integer range/);
  });

  it("Given a payable supplier invoice, when queried, then the partner balance is negative", () => {
    let ledger = addBusinessPartner(emptyCommercialLedger(), {
      id: "supplier-1", tenantId: "tenant-a", name: "Lieferant GmbH", role: "SUPPLIER",
    });
    ledger = createInvoiceDraft(ledger, {
      ...invoiceInput, id: "supplier-invoice", partnerId: "supplier-1", direction: "PAYABLE",
    });
    ledger = issueCommercialDocument(ledger, "tenant-a", "supplier-invoice", "ER-100", "2026-08-01");
    expect(getPartnerOpenBalance(ledger, "tenant-a", "supplier-1", "EUR")).toBe(-11_900);
  });
});
