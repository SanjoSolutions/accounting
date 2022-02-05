import { describe, expect, it } from '@jest/globals';
import { Account } from './Account';
import { AccountPurpose } from './AccountPurpose';
import { AccountPurposeToAccountMapping } from './AccountPurposeToAccountMapping.js';
describe('AccountPurposeToAccountMapping', () => {
    it('maps account purposes to accounts in an chart of accounts', () => {
        const mapping = new AccountPurposeToAccountMapping();
        const bankAccount = new Account(1210, 'Bank 1');
        mapping.map(AccountPurpose.Bank1, bankAccount);
        expect(mapping.get(AccountPurpose.Bank1)).toBe(bankAccount);
    });
});
//# sourceMappingURL=AccountPurposeToAccountMapping.spec.js.map