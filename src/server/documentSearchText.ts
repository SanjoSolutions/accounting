import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
// Trace the packages loaded inside the isolated worker in production builds.
import '@napi-rs/canvas'
import 'pdfjs-dist/legacy/build/pdf.mjs'
import 'saxes'
import type { DocumentSearchStatus } from '@/core/documentSearch'

export type SearchTextResult = { text: string; status: DocumentSearchStatus; source: string | null; failureCode: string | null }
export type SearchTextExtractor = (file: { content: Buffer; contentType: string }) => Promise<SearchTextResult>
export class SearchTextError extends Error {}
let activeWorkers = 0
export const searchIndexTimeoutMs = 60_000

export function extractDocumentSearchText(
  file: { content: Buffer; contentType: string },
  options: { timeoutMs?: number; workerPath?: string; ocrCommand?: string; ocrLanguages?: string } = {},
): Promise<SearchTextResult> {
  if (file.content.length > 20 * 1024 * 1024) return Promise.reject(new SearchTextError('INPUT_LIMIT'))
  if (activeWorkers >= 1) return Promise.reject(new SearchTextError('BUSY'))
  const ocrCommand = options.ocrCommand ?? process.env.DOCUMENT_SEARCH_OCR_COMMAND
  const ocrLanguages = options.ocrLanguages ?? process.env.DOCUMENT_SEARCH_OCR_LANGUAGES ?? 'deu+eng'
  if (!/^[a-zA-Z0-9_+]+$/.test(ocrLanguages)) return Promise.reject(new SearchTextError('OCR_CONFIGURATION'))
  const controller = new AbortController()
  const worker = new Worker(options.workerPath ?? join(process.cwd(), 'src/server/documentSearchWorker.mjs'), {
    workerData: { content: file.content, contentType: file.contentType, ocrEnabled: Boolean(ocrCommand) },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 },
  })
  activeWorkers++
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new SearchTextError('TIMEOUT')), options.timeoutMs ?? searchIndexTimeoutMs)
    worker.on('message', async message => {
      if (settled) return
      if (message.type === 'ocr') {
        try {
          const text = await recognizeImage(ocrCommand!, ocrLanguages, Buffer.from(message.image), controller.signal)
          if (!settled) worker.postMessage({ text })
        } catch { if (!settled) worker.postMessage({ error: 'OCR_FAILURE' }) }
      } else if (message.type === 'result') finish(undefined, message.result)
      else if (message.type === 'failure') finish(new SearchTextError(message.code))
    })
    worker.once('error', () => finish(new SearchTextError('PARSER_FAILURE')))
    worker.once('exit', () => { activeWorkers--; finish(new SearchTextError('PARSER_FAILURE')) })
    function finish(error?: Error, result?: SearchTextResult) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      controller.abort()
      void worker.terminate().finally(() => {
        if (error) reject(error)
        else resolve(result!)
      })
    }
  })
}

function recognizeImage(command: string, languages: string, image: Buffer, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, ['stdin', 'stdout', '-l', languages], {
      timeout: 15_000, maxBuffer: 2_000_000, windowsHide: true, signal,
      env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    }, (error, stdout) => error ? reject(new SearchTextError('OCR_FAILURE')) : resolve(stdout))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(image)
  })
}
