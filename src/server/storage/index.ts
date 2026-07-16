import 'server-only'

import { Operator, RetryLayer } from 'opendal'
import { DocumentStorage } from './DocumentStorage'
import { getOpenDalConfig } from './config'

let storage: DocumentStorage | undefined

export function getDocumentStorage(): DocumentStorage {
  storage ??= createDocumentStorage()
  return storage
}

function createDocumentStorage(): DocumentStorage {
  const { driver, options } = getOpenDalConfig()
  const operator = new Operator(driver, options)
  const retry = new RetryLayer()
  retry.maxTimes = 3
  retry.jitter = true

  return new DocumentStorage(operator.layer(retry.build()))
}
