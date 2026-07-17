import { writeSync } from 'node:fs'

for await (const _chunk of process.stdin) {
  // Consume the input before returning a synthetic thumbnail.
}

console.log('diagnostic emitted on stdout')
writeSync(3, Buffer.from('RIFFxxxxWEBP'))
