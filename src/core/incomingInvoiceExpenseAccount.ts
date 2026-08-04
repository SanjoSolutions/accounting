export type IncomingInvoiceExpenseAccountCandidate = {
  id: string
  number: number
  name: string
  eBilanzPosition: string | null
}

const PREFERRED_GENERAL_EXPENSE_ACCOUNT: Readonly<Record<string, number>> = {
  SKR03: 4930,
  SKR04: 6815,
}

export function recommendIncomingInvoiceExpenseAccount(
  chart: string | null | undefined,
  accountLength: number | null | undefined,
  accounts: IncomingInvoiceExpenseAccountCandidate[],
): string | null {
  const generalExpenses = accounts.filter(account => !isDepreciationExpense(account))
  if (!generalExpenses.length) return null

  const scale = 10 ** ((accountLength ?? 4) - 4)
  const preferredNumber = chart ? PREFERRED_GENERAL_EXPENSE_ACCOUNT[chart] * scale : undefined
  const preferred = generalExpenses.find(account => account.number === preferredNumber)
  if (preferred) return preferred.id

  return [...generalExpenses].sort((left, right) => left.number - right.number || left.id.localeCompare(right.id))[0].id
}

function isDepreciationExpense(account: IncomingInvoiceExpenseAccountCandidate) {
  return account.eBilanzPosition?.includes('deprAmort') === true || /abschreib|depreciat/i.test(account.name)
}
