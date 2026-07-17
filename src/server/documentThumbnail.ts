import { spawn } from 'node:child_process'
import { join } from 'node:path'
// Keep the worker's runtime packages visible to Next.js output-file tracing.
import '@napi-rs/canvas'
import 'pdfjs-dist/legacy/build/pdf.mjs'

export const documentThumbnailCssWidth = 132
export const documentThumbnailCssHeight = 130
export const documentThumbnailDeviceScale = 2
export const documentThumbnailMaxWidth = documentThumbnailCssWidth * documentThumbnailDeviceScale
export const documentThumbnailMaxHeight = documentThumbnailCssHeight * documentThumbnailDeviceScale
export const documentThumbnailTimeoutMs = 5_000
export const documentThumbnailWorkerMemoryMb = 128
export const documentThumbnailMaxInputBytes = 20 * 1024 * 1024
export const documentThumbnailMaxOutputBytes = 1024 * 1024
export const documentThumbnailMaxImagePixels = 36_000_000
export const documentThumbnailCanvasMaxAreaBytes = 64 * 1024 * 1024
export const documentThumbnailMaxConcurrentWorkers = 1

let activeThumbnailWorkers = 0

type ThumbnailWorkerOptions = {
  workerPath?: string
  timeoutMs?: number
}

export function generateDocumentThumbnail(
  content: Buffer,
  options: ThumbnailWorkerOptions = {},
): Promise<Buffer> {
  if (content.length > documentThumbnailMaxInputBytes) {
    return Promise.reject(new Error('Document exceeds the thumbnail worker input limit'))
  }
  if (activeThumbnailWorkers >= documentThumbnailMaxConcurrentWorkers) {
    return Promise.reject(new Error('Document thumbnail worker capacity is exhausted'))
  }

  const workerPath = options.workerPath ?? join(process.cwd(), 'src', 'server', 'documentThumbnailWorker.mjs')
  const timeoutMs = options.timeoutMs ?? documentThumbnailTimeoutMs

  const worker = spawn(process.execPath, [
      `--max-old-space-size=${ documentThumbnailWorkerMemoryMb }`,
      '--max-semi-space-size=8',
      workerPath,
      String(documentThumbnailMaxWidth),
      String(documentThumbnailMaxHeight),
      String(documentThumbnailMaxInputBytes),
      String(documentThumbnailMaxImagePixels),
      String(documentThumbnailCanvasMaxAreaBytes),
    ], {
      // Keep the binary image isolated from stdout, where PDF.js and native
      // dependencies may emit diagnostics for otherwise renderable documents.
      stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  const workerInput = worker.stdin!
  const errorOutput = worker.stderr!
  const imageOutput = worker.stdio[3]!
  activeThumbnailWorkers += 1

  return new Promise<Buffer>((resolve, reject) => {
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let outputBytes = 0
    let errorBytes = 0
    let settled = false
    let slotReleased = false
    let forcedError: Error | undefined

    const timer = setTimeout(() => {
      forcedError = new Error(`Document thumbnail generation exceeded ${ timeoutMs } ms`)
      worker.kill('SIGKILL')
    }, timeoutMs)

    imageOutput.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > documentThumbnailMaxOutputBytes) {
        forcedError = new Error('Document thumbnail exceeded the output limit')
        worker.kill('SIGKILL')
        return
      }
      output.push(chunk)
    })
    errorOutput.on('data', (chunk: Buffer) => {
      if (errorBytes >= 16 * 1024) return
      const captured = chunk.subarray(0, 16 * 1024 - errorBytes)
      errorBytes += captured.length
      errors.push(captured)
    })
    workerInput.on('error', () => undefined)
    worker.on('error', error => {
      releaseSlot()
      finish(error)
    })
    worker.on('close', code => {
      releaseSlot()
      if (settled) return
      if (forcedError) {
        finish(forcedError)
        return
      }
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim()
        finish(new Error(detail || `Document thumbnail worker exited with code ${ code }`))
        return
      }
      const thumbnail = Buffer.concat(output, outputBytes)
      if (!isWebP(thumbnail)) {
        finish(new Error('Document thumbnail worker returned an invalid image'))
        return
      }
      finish(undefined, thumbnail)
    })

    workerInput.end(content)

    function finish(error?: Error, thumbnail?: Buffer) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(thumbnail!)
    }

    function releaseSlot() {
      if (slotReleased) return
      slotReleased = true
      activeThumbnailWorkers -= 1
    }
  })
}

export function fitDocumentThumbnail(pageWidth: number, pageHeight: number): { width: number; height: number } {
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
    throw new Error('The PDF page has invalid dimensions')
  }
  const scale = Math.min(documentThumbnailMaxWidth / pageWidth, documentThumbnailMaxHeight / pageHeight)
  return {
    width: Math.max(1, Math.round(pageWidth * scale)),
    height: Math.max(1, Math.round(pageHeight * scale)),
  }
}

function isWebP(content: Buffer): boolean {
  return content.length >= 12
    && content.subarray(0, 4).toString('ascii') === 'RIFF'
    && content.subarray(8, 12).toString('ascii') === 'WEBP'
}
