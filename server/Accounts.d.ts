import { ICollection } from "@sanjo/database/ICollection";
import { Account } from "accounting-core/authentication/Account.js";
export declare class Accounts {
    collection: ICollection;
    constructor(collection: ICollection);
    findOne(id: string): Promise<Account | null>;
    save(account: Account): Promise<void>;
}
//# sourceMappingURL=Accounts.d.ts.map