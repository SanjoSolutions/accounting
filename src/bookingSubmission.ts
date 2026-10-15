export type BookingSubmissionMode = 'post' | 'draft'
export type SavedBooking = { id: string; version: number }
type BookingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export class BookingSubmissionError extends Error {
  constructor(readonly issues: string[]) { super(issues.join(' ')) }
}

async function responseBody(response: Response, fallback: string) {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const issues = Array.isArray(body?.issues) ? body.issues.filter((value: unknown) => typeof value === 'string') : []
    throw new BookingSubmissionError(issues.length ? issues : [typeof body?.error === 'string' ? body.error : fallback])
  }
  return body
}

/** A draft is saved first, so posting retries always address the same durable entry. */
export async function saveBooking(input: unknown, fallback: string, fetcher = fetch): Promise<SavedBooking> {
  let response: Response
  try {
    response = await fetcher('/api/booking-records', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
  } catch { throw new BookingSubmissionError([fallback]) }
  const body = await responseBody(response, fallback)
  if (typeof body?.id !== 'string' || !body.id || !Number.isInteger(body.version) || body.version < 1) throw new BookingSubmissionError([fallback])
  return { id: body.id, version: body.version }
}

export async function postSavedBooking(booking: SavedBooking, fallback: string, fetcher = fetch) {
  const body = await responseBody(await fetcher(`/api/booking-batches/${encodeURIComponent(booking.id)}/post`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: booking.version }),
  }), fallback)
  if (typeof body?.id !== 'string' || !body.id) throw new BookingSubmissionError([fallback])
}

function pendingKey(ownerId: string, year: number) {
  return `accounting.bookings.pending-post.${encodeURIComponent(ownerId)}.${year}`
}

export function loadPendingBooking(storage: BookingStorage | null, ownerId: string, year: number): SavedBooking | null {
  try {
    const value = JSON.parse(storage?.getItem(pendingKey(ownerId, year)) ?? 'null')
    return typeof value?.id === 'string' && value.id && Number.isInteger(value.version) && value.version > 0
      ? { id: value.id, version: value.version } : null
  } catch { return null }
}

export function storePendingBooking(storage: BookingStorage | null, ownerId: string, year: number, booking: SavedBooking | null) {
  if (!storage) return false
  try {
    if (booking) storage.setItem(pendingKey(ownerId, year), JSON.stringify(booking))
    else storage.removeItem(pendingKey(ownerId, year))
    return true
  } catch {
    return false
  }
}
