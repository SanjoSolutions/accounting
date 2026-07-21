CREATE TRIGGER "InvoiceNumberSequenceOnboarding_immutable_update"
BEFORE UPDATE ON "InvoiceNumberSequenceOnboarding"
BEGIN
  SELECT RAISE(ABORT, 'invoice-number onboarding reconciliation evidence is immutable');
END;

CREATE TRIGGER "InvoiceNumberSequenceOnboarding_immutable_delete"
BEFORE DELETE ON "InvoiceNumberSequenceOnboarding"
BEGIN
  SELECT RAISE(ABORT, 'invoice-number onboarding reconciliation evidence is immutable');
END;
