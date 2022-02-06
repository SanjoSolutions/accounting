import { ICollection } from "@sanjo/database/ICollection"
import { Account } from "accounting-core/authentication/Account.js"

export class Accounts {
  collection: ICollection

  constructor(collection: ICollection) {
    this.collection = collection
  }

  async findOne(id: string): Promise<Account | null> {
    return (await this.collection.find()).find((account: any) => account.id === id) ?? null
  }

  async save(account: Account): Promise<void> {
    this.collection.update({ id: account.id }, account)
  }
}
