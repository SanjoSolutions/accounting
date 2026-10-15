import { describe, expect, test, vi } from 'vitest'
import { loadPendingBooking, postSavedBooking, saveBooking, storePendingBooking } from './bookingSubmission'

describe('optional booking submission', () => {
  test('Given a booking for review, when saved, then only a durable draft is created', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'draft/1', version: 2 }))
    const input = { fiscalYear: 2026, description: 'Receipt', lines: [], documentIds: ['document'] }
    expect(await saveBooking(input, 'failed', fetcher)).toEqual({ id: 'draft/1', version: 2 })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/booking-records', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }))
  })

  test('Given an uncertain posting response, when retried, then the same saved draft and reviewed version are submitted', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(Response.json({ id: 'entry-1' }))
    const draft = { id: 'draft/1', version: 2 }
    await expect(postSavedBooking(draft, 'failed', fetcher)).rejects.toThrow('connection lost')
    await postSavedBooking(draft, 'failed', fetcher)
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1])
    expect(fetcher).toHaveBeenLastCalledWith('/api/booking-batches/draft%2F1/post', expect.objectContaining({ body: JSON.stringify({ expectedVersion: 2 }) }))
  })

  test('Given invalid data or an unconfirmed response, when saving, then it cannot be treated as success', async () => {
    for (const body of [{}, { id: 'draft', version: 0 }, { id: 'draft', version: '1' }]) {
      await expect(saveBooking({}, 'unconfirmed', vi.fn().mockResolvedValue(Response.json(body)))).rejects.toThrow('unconfirmed')
    }
    await expect(saveBooking({}, 'failed', vi.fn().mockResolvedValue(Response.json({ issues: ['Unbalanced'] }, { status: 400 })))).rejects.toMatchObject({ issues: ['Unbalanced'] })
    await expect(postSavedBooking({ id: 'draft', version: 1 }, 'failed', vi.fn().mockResolvedValue(Response.json({ error: 'Draft changed concurrently' }, { status: 409 })))).rejects.toThrow('Draft changed concurrently')
    await expect(postSavedBooking({ id: 'draft', version: 1 }, 'unconfirmed', vi.fn().mockResolvedValue(new Response('not JSON')))).rejects.toThrow('unconfirmed')
    await expect(saveBooking({}, 'Check batches before retrying', vi.fn().mockRejectedValue(new Error('connection lost')))).rejects.toThrow('Check batches before retrying')
  })
})

describe('pending booking recovery', () => {
  test('Given a pending post, when reloaded, then recovery is scoped to its tenant and fiscal year', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
    const draft = { id: 'draft-1', version: 2 }
    storePendingBooking(storage, 'tenant-a', 2026, draft)
    expect(loadPendingBooking(storage, 'tenant-a', 2026)).toEqual(draft)
    expect(loadPendingBooking(storage, 'tenant-b', 2026)).toBeNull()
    expect(loadPendingBooking(storage, 'tenant-a', 2025)).toBeNull()
    storePendingBooking(storage, 'tenant-a', 2026, null)
    expect(loadPendingBooking(storage, 'tenant-a', 2026)).toBeNull()
  })

  test('Given unavailable or corrupt storage, when restoring, then the form remains usable', () => {
    expect(loadPendingBooking(null, 'tenant', 2026)).toBeNull()
    const storage = { getItem: () => '{', setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('blocked') } }
    expect(loadPendingBooking(storage, 'tenant', 2026)).toBeNull()
    expect(storePendingBooking(storage, 'tenant', 2026, { id: 'draft', version: 1 })).toBe(false)
    expect(storePendingBooking(storage, 'tenant', 2026, null)).toBe(false)
    expect(storePendingBooking(null, 'tenant', 2026, { id: 'draft', version: 1 })).toBe(false)
  })
})
