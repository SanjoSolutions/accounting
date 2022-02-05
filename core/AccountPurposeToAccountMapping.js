export class AccountPurposeToAccountMapping {
    _map = new Map();
    map(accountPurpose, account) {
        this._map.set(accountPurpose, account);
    }
    get(accountPurpose) {
        return this._map.get(accountPurpose) ?? null;
    }
}
//# sourceMappingURL=AccountPurposeToAccountMapping.js.map