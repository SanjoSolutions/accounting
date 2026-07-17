import { Account } from "./Account";

export const chartOfAccountsStandards = ['SKR03', 'SKR04'] as const

export type ChartOfAccountsStandard = typeof chartOfAccountsStandards[number]

export function isChartOfAccountsStandard(value: unknown): value is ChartOfAccountsStandard {
    return chartOfAccountsStandards.some((standard) => standard === value)
}

export function chartOfAccountsStandardLabel(standard: ChartOfAccountsStandard): string {
    return `${ standard.slice(0, 3) } ${ standard.slice(3) }`
}

export class ChartOfAccounts {
    addAccount(account: Account) {

    }
}
