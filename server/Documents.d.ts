import type { Document } from 'accounting-core/Document.js';
import { ICollection } from '@sanjo/database/ICollection.js';
export declare class Documents {
    collection: ICollection;
    constructor(collection: ICollection);
    findOne(id: string): Promise<Document | null>;
    save(document: Document): Promise<void>;
}
//# sourceMappingURL=Documents.d.ts.map