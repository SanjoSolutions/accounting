import { Address } from "../Address.js";
export class Account {
    id;
    invoiceIssuer = Address.createNullAddress();
    constructor(id) {
        this.id = id;
    }
}
//# sourceMappingURL=Account.js.map