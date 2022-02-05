import { Unit } from "./Unit";
export class InvoiceItem {
    description = '';
    amountOfUnit = 0;
    unit = Unit.None;
    pricePerUnit = 0;
    get netAmount() {
        return this.amountOfUnit * this.pricePerUnit;
    }
}
//# sourceMappingURL=InvoiceItem.js.map