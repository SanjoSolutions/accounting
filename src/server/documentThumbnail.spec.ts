import { describe, expect, it } from 'vitest'
import { loadImage } from '@napi-rs/canvas'
import { join } from 'node:path'
import { documentThumbnailCanvasMaxAreaBytes, documentThumbnailMaxConcurrentWorkers, documentThumbnailMaxHeight, documentThumbnailMaxImagePixels, documentThumbnailMaxWidth, documentThumbnailWorkerMemoryMb, fitDocumentThumbnail, generateDocumentThumbnail } from './documentThumbnail'

describe('document thumbnails', () => {
  it('fits portrait and landscape pages within the thumbnail bounds', () => {
    expect({ width: documentThumbnailMaxWidth, height: documentThumbnailMaxHeight }).toEqual({ width: 264, height: 260 })
    expect(fitDocumentThumbnail(600, 800)).toEqual({ width: 195, height: 260 })
    expect(fitDocumentThumbnail(1_200, 600)).toEqual({ width: 264, height: 132 })
    expect(fitDocumentThumbnail(100, 100)).toEqual({ width: 260, height: 260 })
    expect(documentThumbnailWorkerMemoryMb).toBe(128)
    expect(documentThumbnailMaxImagePixels).toBe(36_000_000)
    expect(documentThumbnailCanvasMaxAreaBytes).toBe(64 * 1024 * 1024)
  })

  it('terminates thumbnail workers that exceed their execution budget', async () => {
    await expect(generateDocumentThumbnail(minimalPdf(), {
      workerPath: join(process.cwd(), 'src', 'server', 'dataFixtures', 'hangingThumbnailWorker.mjs'),
      timeoutMs: 100,
    })).rejects.toThrow('exceeded 100 ms')
  })

  it('rejects thumbnail work beyond the process-wide worker limit', async () => {
    const workerPath = join(process.cwd(), 'src', 'server', 'dataFixtures', 'hangingThumbnailWorker.mjs')
    const running = Array.from({ length: documentThumbnailMaxConcurrentWorkers }, () =>
      generateDocumentThumbnail(minimalPdf(), { workerPath, timeoutMs: 200 }),
    )
    const rejections = running.map(result => expect(result).rejects.toThrow('exceeded 200 ms'))

    await expect(generateDocumentThumbnail(minimalPdf(), { workerPath, timeoutMs: 200 }))
      .rejects.toThrow('capacity is exhausted')
    await Promise.all(rejections)
  })

  it('renders the first PDF page as WebP once for storage', async () => {
    const thumbnail = await generateDocumentThumbnail(minimalPdf())

    expect(thumbnail.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(thumbnail.subarray(8, 12).toString('ascii')).toBe('WEBP')
    expect(thumbnail.length).toBeGreaterThan(100)
    const image = await loadImage(thumbnail)
    expect({ width: image.width, height: image.height }).toEqual({ width: 264, height: 132 })
  })

  it('rejects blank renders so omitted oversized scans use the UI fallback', async () => {
    await expect(generateDocumentThumbnail(blankPdf())).rejects.toThrow('blank')
  })
})

function minimalPdf(): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj
2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj
3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>> endobj
4 0 obj <</Length 37>> stream
BT /F1 20 Tf 20 50 Td (Test) Tj ET
endstream endobj
5 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj
trailer <</Root 1 0 R>>
%%EOF`)
}

function blankPdf(): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj
2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj
3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>> endobj
trailer <</Root 1 0 R>>
%%EOF`)
}
