export const PRISMA_INT_MIN = -2_147_483_648
export const PRISMA_INT_MAX = 2_147_483_647
export function isPrismaInt(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= PRISMA_INT_MIN && (value as number) <= PRISMA_INT_MAX }
