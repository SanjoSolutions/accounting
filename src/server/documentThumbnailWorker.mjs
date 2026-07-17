import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const [maxWidth, maxHeight, maxInputBytes, maxImageSize, canvasMaxAreaInBytes] = process.argv.slice(2).map(Number)

try {
  validatePositiveInteger(maxWidth, 'maximum width')
  validatePositiveInteger(maxHeight, 'maximum height')
  validatePositiveInteger(maxInputBytes, 'maximum input size')
  validatePositiveInteger(maxImageSize, 'maximum decoded image size')
  validatePositiveInteger(canvasMaxAreaInBytes, 'maximum canvas area')
  const content = await readInput(maxInputBytes)
  const loadingTask = getDocument({
    data: new Uint8Array(content),
    maxImageSize,
    canvasMaxAreaInBytes,
    useSystemFonts: true,
  })

  try {
    const pdf = await loadingTask.promise
    const page = await pdf.getPage(1)
    const naturalViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(maxWidth / naturalViewport.width, maxHeight / naturalViewport.height)
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.round(viewport.width))
    const height = Math.max(1, Math.round(viewport.height))
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    await page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise
    if (!hasVisibleContent(context.getImageData(0, 0, width, height).data)) {
      throw new Error('Rendered document thumbnail is blank')
    }
    process.stdout.write(canvas.toBuffer('image/webp', 80))
  } finally {
    await loadingTask.destroy()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Document thumbnail generation failed')
  process.exitCode = 1
}

async function readInput(limit) {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > limit) throw new Error('Document exceeds the thumbnail worker input limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${ name }`)
}

function hasVisibleContent(pixels) {
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] && (pixels[index] < 250 || pixels[index + 1] < 250 || pixels[index + 2] < 250)) {
      return true
    }
  }
  return false
}
