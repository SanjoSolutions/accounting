export class Document {
  id: string
  url: string
  gsURL?: string

  constructor(id: string, url: string) {
    this.id = id
    this.url = url
  }
}
