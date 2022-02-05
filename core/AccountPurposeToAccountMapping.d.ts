import type { Account } from './Account';
import type { AccountPurpose } from './AccountPurpose';
export declare class AccountPurposeToAccountMapping {
    _map: Map<AccountPurpose, Account>;
    map(accountPurpose: AccountPurpose, account: Account): void;
    get(accountPurpose: AccountPurpose): Account | null;
}
//# sourceMappingURL=AccountPurposeToAccountMapping.d.ts.map