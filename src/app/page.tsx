import { CreateBookingRecord } from '../CreateBookingRecord'
import { requirePageUser } from '@/server/authentication'

export default async function HomePage() {
  await requirePageUser()
  return <CreateBookingRecord />
}
