export function compareCanonicalText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0 }

export function compareDottedVersions(left: string, right: string) {
  const leftParts = left.split('.'); const rightParts = right.split('.'); const count = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < count; index++) {
    const leftPart = leftParts[index] ?? ''; const rightPart = rightParts[index] ?? ''
    if (/^\d+$/.test(leftPart) && /^\d+$/.test(rightPart)) {
      const normalizedLeft = leftPart.replace(/^0+(?=\d)/, ''); const normalizedRight = rightPart.replace(/^0+(?=\d)/, '')
      if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length < normalizedRight.length ? -1 : 1
      const numeric = compareCanonicalText(normalizedLeft, normalizedRight); if (numeric) return numeric
      continue
    }
    const lexical = compareCanonicalText(leftPart, rightPart); if (lexical) return lexical
  }
  return 0
}
