import { redirect } from 'next/navigation'
import { AuthenticationForm } from '@/AuthenticationForm'
import { getAuthMode, isSignUpEnabled } from '@/server/auth-mode'

export default function SignUpPage() {
  if (getAuthMode() === 'none') redirect('/')
  if (!isSignUpEnabled()) redirect('/sign-in')
  return <AuthenticationForm mode="sign-up" />
}
