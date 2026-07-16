import { redirect } from 'next/navigation'
import { AuthenticationForm } from '@/AuthenticationForm'
import { getAuthMode, isSignUpEnabled } from '@/server/auth-mode'

export default function SignInPage() {
  if (getAuthMode() === 'none') redirect('/')
  return <AuthenticationForm mode="sign-in" signUpEnabled={isSignUpEnabled()} />
}
