export class Documents {
    collection;
    constructor(collection) {
        this.collection = collection;
    }
    async findOne(id) {
        return (await this.collection.find()).find((document) => document.id === id) ?? null;
    }
    async save(document) {
        this.collection.insert(document);
    }
}
//# sourceMappingURL=Documents.js.map