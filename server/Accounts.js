export class Accounts {
    collection;
    constructor(collection) {
        this.collection = collection;
    }
    async findOne(id) {
        return (await this.collection.find()).find((account) => account.id === id) ?? null;
    }
    async save(account) {
        this.collection.update({ id: account.id }, account);
    }
}
//# sourceMappingURL=Accounts.js.map