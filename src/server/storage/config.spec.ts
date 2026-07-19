import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAuthoritativeStorageRegion, getOpenDalConfig } from './config'

describe('getOpenDalConfig', () => {
  it('uses a local storage directory by default', () => {
    expect(getOpenDalConfig({}, '/app')).toEqual({
      driver: 'fs',
      options: { root: path.resolve('/app', 'storage') },
    })
  })

  it('maps S3 environment variables to OpenDAL options', () => {
    expect(getOpenDalConfig({
      DOCUMENT_STORAGE_DRIVER: 's3',
      DOCUMENT_STORAGE_BUCKET: 'documents',
      DOCUMENT_STORAGE_REGION: 'eu-central-1',
      DOCUMENT_STORAGE_OPTIONS: '{"root":"accounting"}',
    })).toEqual({
      driver: 's3',
      options: {
        bucket: 'documents',
        region: 'eu-central-1',
        root: 'accounting',
      },
    })
  })

  it('rejects missing provider configuration', () => {
    expect(() => getOpenDalConfig({ DOCUMENT_STORAGE_DRIVER: 'gcs' }))
      .toThrow('DOCUMENT_STORAGE_BUCKET is required')
  })
  it('uses deployment storage configuration as the authoritative compliance region', () => {
    expect(getAuthoritativeStorageRegion({ DOCUMENT_STORAGE_REGION: 'eu-central-1' })).toBe('eu-central-1')
    expect(() => getAuthoritativeStorageRegion({})).toThrow(/required/)
  })
})
