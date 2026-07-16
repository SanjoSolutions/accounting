import { Settings } from '../../Settings'
import { requirePageUser } from '@/server/authentication'

export default async function SettingsPage() {
  await requirePageUser()
  return <Settings />
}
