import { parentPort, workerData } from 'node:worker_threads'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { SaxesParser } from 'saxes'

const MAX_TEXT = 500_000
const MAX_PAGES = 100
const pages = []
let length = 0
let usedOcr = false
let missingOcr = false

function addText(text) {
  length += text.length
  if (length > MAX_TEXT) throw new Error('TEXT_LIMIT')
  pages.push(text)
}

try {
  if (workerData.contentType.includes('xml')) {
    const parser = new SaxesParser()
    parser.on('doctype', () => { throw new Error('UNSUPPORTED_XML') })
    parser.on('text', addText)
    parser.on('cdata', addText)
    parser.write(Buffer.from(workerData.content).toString('utf8')).close()
  } else {
    const loading = getDocument({ data: new Uint8Array(workerData.content), useSystemFonts: true, verbosity: 0, isEvalSupported: false, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32_000_000 })
    try {
      const pdf = await loading.promise
      if (pdf.numPages > MAX_PAGES) throw new Error('PAGE_LIMIT')
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index)
        const text = (await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str + (item.hasEOL ? '\n' : ' ')] : []).join('').trim()
        if (text) addText(text)
        else if (!workerData.ocrEnabled) missingOcr = true
        else {
          const natural = page.getViewport({ scale: 1 })
          const scale = Math.min(2, 2400 / Math.max(natural.width, natural.height))
          const viewport = page.getViewport({ scale })
          const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
          await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise
          const reply = new Promise(resolve => parentPort.once('message', resolve))
          parentPort.postMessage({ type: 'ocr', image: canvas.toBuffer('image/png') })
          const result = await reply
          if (result.error) throw new Error(result.error)
          addText(result.text)
          usedOcr = true
        }
        page.cleanup()
      }
    } finally { await loading.destroy() }
  }
  const text = pages.join('\n').trim()
  parentPort.postMessage({ type: 'result', result: {
    text,
    status: missingOcr ? (text ? 'PARTIAL' : 'NEEDS_OCR') : 'READY',
    source: workerData.contentType.includes('xml') ? 'XML' : usedOcr ? 'OCR' : 'PDF_TEXT',
    failureCode: missingOcr ? 'OCR_NOT_CONFIGURED' : null,
  } })
} catch (error) {
  parentPort.postMessage({ type: 'failure', code: ['TEXT_LIMIT', 'PAGE_LIMIT', 'OCR_FAILURE', 'UNSUPPORTED_XML'].includes(error.message) ? error.message : 'PARSER_FAILURE' })
} finally { parentPort.close() }
