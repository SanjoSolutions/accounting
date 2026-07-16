UPDATE "LedgerAccount"
SET "eBilanzPosition" = 'bs.eqLiab.liab.other.theroffTax.vat'
WHERE "number" = 1776
  AND "eBilanzPosition" = 'bs.eqLiab.liab.other.vat';

UPDATE "LedgerAccount"
SET "eBilanzPosition" = 'is.netIncome.regular.operatingTC.otherCost'
WHERE "number" = 4930
  AND "eBilanzPosition" = 'is.netIncome.regular.operatingTC.otherCost.material';
