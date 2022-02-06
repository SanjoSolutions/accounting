import { describe, it, expect } from '@jest/globals'
import { Document } from './Document'

describe('Document', () => {
  it('is the basis for booking records', () => {
    const document = new Document('1', 'http://example.com')
  })
})
