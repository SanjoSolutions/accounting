export function parseEuerAmount(value: string): number {
  const match = /^(-?)(\d{1,14})(?:[.,](\d{1,2}))?$/.exec(value.trim())
  if (!match) throw new Error('amount')
  const cents = BigInt(match[2]) * BigInt(100) + BigInt((match[3] ?? '').padEnd(2, '0'))
  if (cents === BigInt(0) || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount')
  return Number(cents) * (match[1] ? -1 : 1)
}
