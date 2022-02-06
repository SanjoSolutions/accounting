import { Address } from "../Address.js";
export class Account {
    id;
    address = Address.createNullAddress();
    invoiceIssuer = Address.createNullAddress();
    constructor(id) {
        this.id = id;
    }
}
//# sourceMappingURL=Account.js.map