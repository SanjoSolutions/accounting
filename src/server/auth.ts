import 'server-only'

import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { nextCookies } from 'better-auth/next-js'
import { isCredentialAuthEnabled } from './auth-mode'
import { prisma } from './persistence/client'

const credentialAuthEnabled = isCredentialAuthEnabled()

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'sqlite',
  }),
  account: {
    modelName: 'AuthAccount',
  },
  emailAndPassword: {
    enabled: credentialAuthEnabled,
    disableSignUp: process.env.BETTER_AUTH_DISABLE_SIGN_UP === 'true',
  },
  plugins: [nextCookies()],
})
