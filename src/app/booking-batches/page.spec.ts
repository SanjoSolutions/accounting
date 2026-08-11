import { describe, expect, test, vi } from 'vitest'

const { requirePageUser } = vi.hoisted(() => ({ requirePageUser: vi.fn(async () => ({ id: 'owner-1' })) }))
vi.mock('@/server/authentication', () => ({ requirePageUser }))
vi.mock('@/BookingBatchWorkspace', () => ({ BookingBatchWorkspace: vi.fn(() => null) }))

import BookingBatchesPage from './page'

describe('booking batches page authentication and deep links', () => {
  test('requires an authenticated page user and forwards a valid fiscal year', async () => {
    const element = await BookingBatchesPage({ searchParams: Promise.resolve({ year: '2025' }) })
    expect(requirePageUser).toHaveBeenCalledOnce()
    expect((element as { props: { initialYear: number } }).props.initialYear).toBe(2025)
  })
})
