import type { AccountingWorkspaceView } from './AccountingWorkspace'

export const accountingRouteViews = {
  '/': 'dashboard',
  '/bookings': 'booking',
  '/journal': 'journal',
} as const satisfies Record<string, AccountingWorkspaceView>
