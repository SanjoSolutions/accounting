export function hasDenseOwnElements(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
  }
  return true
}

export function hasDenseNonblankStrings(value: unknown, allowEmpty = false): value is readonly string[] {
  if (!hasDenseOwnElements(value) || (!allowEmpty && value.length === 0)) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!
    if (typeof descriptor.value !== 'string' || !descriptor.value.trim()) return false
  }
  return true
}

export function hasStrictEvidenceIds(value: unknown): value is readonly string[] {
  return hasDenseNonblankStrings(value)
}
