import { toNextJsHandler } from 'better-auth/next-js'
import { isCredentialAuthEnabled, isSignUpEnabled } from '@/server/auth-mode'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!isCredentialAuthEnabled()) return new Response(null, { status: 404 })
  const { auth } = await import('@/server/auth')
  const handlers = toNextJsHandler(auth)
  return handlers.GET(request)
}

export async function POST(request: Request) {
  if (!isCredentialAuthEnabled()) return new Response(null, { status: 404 })
  if (!isSignUpEnabled() && new URL(request.url).pathname.endsWith('/sign-up/email')) {
    return Response.json({ message: 'Sign-up is disabled.' }, { status: 403 })
  }
  const { auth } = await import('@/server/auth')
  const handlers = toNextJsHandler(auth)
  return handlers.POST(request)
}
