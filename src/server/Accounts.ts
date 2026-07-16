import { ICollection } from "@sanjo/database/ICollection"
import { Account } from "@/core/authentication/Account"

export class Accounts {
  collection: ICollection

  constructor(collection: ICollection) {
    this.collection = collection
  }

  async findOne(id: string): Promise<Account | null> {
    return (await this.collection.find()).find((account: any) => account.id === id) ?? null
  }

  async save(account: Account): Promise<void> {
    if (await this.findOne(account.id)) {
      await this.collection.update({ id: account.id }, account)
    } else {
      await this.collection.insert(account)
    }
  }
}
