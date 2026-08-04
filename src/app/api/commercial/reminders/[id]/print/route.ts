import 'server-only'
import { getCurrentUser } from '@/server/authentication'
import { getPrintableReceivablesReminder } from '@/server/receivablesReminderRepository'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  const { id } = await context.params; const reminder = await getPrintableReceivablesReminder(user.id, id)
  if (!reminder) return Response.json({ success: false }, { status: 404 })
  const disposition = new URL(request.url).searchParams.get('download') === '1' ? `attachment; filename="Zahlungserinnerung-${reminder.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, '_')}-${reminder.level}.html"` : 'inline'
  return new Response(reminder.printableHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': disposition, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } })
}
