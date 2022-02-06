import type { Document } from 'accounting-core/Document.js'
import { ICollection } from '@sanjo/database/ICollection.js'

export class Documents {
  collection: ICollection

  constructor(collection: ICollection) {
    this.collection = collection
  }

  async save(document: Document) {
    this.collection.insert(document)
  }
}
