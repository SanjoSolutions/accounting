export class Document {
  id: string
  url: string
  storageKey?: string
  fileName?: string
  contentType?: string
  size?: number
  ownerId?: string
  thumbnailStorageKey?: string
  thumbnailUrl?: string

  constructor(
    id: string,
    url: string,
    storageKey?: string,
    fileName?: string,
    contentType?: string,
    size?: number,
    ownerId?: string,
    thumbnailStorageKey?: string,
    thumbnailUrl?: string,
  ) {
    this.id = id
    this.url = url
    this.storageKey = storageKey
    this.fileName = fileName
    this.contentType = contentType
    this.size = size
    this.ownerId = ownerId
    this.thumbnailStorageKey = thumbnailStorageKey
    this.thumbnailUrl = thumbnailUrl
  }
}
