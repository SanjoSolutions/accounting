import { ComplianceWorkspace } from '@/ComplianceWorkspace'
import { requirePageUser } from '@/server/authentication'

export default async function CompliancePage() { await requirePageUser(); return <ComplianceWorkspace /> }
