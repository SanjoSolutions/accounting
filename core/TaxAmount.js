import { Tax } from './Tax.js';
export class TaxAmount {
    amount;
    tax;
    static createNullTaxAmount() {
        return new TaxAmount(0, Tax.createNullTax());
    }
    constructor(amount, tax) {
        this.amount = amount;
        this.tax = tax;
    }
}
//# sourceMappingURL=TaxAmount.js.map