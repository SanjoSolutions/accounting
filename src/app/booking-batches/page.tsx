import { BookingBatchWorkspace, bookingBatchYearFromSearchParameter } from '@/BookingBatchWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function BookingBatchesPage({ searchParams }: {
  searchParams: Promise<{ year?: string | string[] }>
}) {
  await requirePageUser()
  const initialYear = bookingBatchYearFromSearchParameter((await searchParams).year)
  return <BookingBatchWorkspace key={`booking-batches:${initialYear}`} initialYear={initialYear} />
}
