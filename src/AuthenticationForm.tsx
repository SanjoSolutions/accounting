"use client"

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { authClient } from './auth-client'

export function AuthenticationForm({
  mode,
  signUpEnabled = true,
}: {
  mode: 'sign-in' | 'sign-up'
  signUpEnabled?: boolean
}) {
  const t = useTranslations('Authentication')
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)

    const fields = Object.fromEntries(new FormData(event.currentTarget)) as {
      email: string
      name: string
    } & Record<'password', string>

    const result = mode === 'sign-up'
      ? await authClient.signUp.email(fields)
      : await authClient.signIn.email(fields)

    setIsSubmitting(false)

    if (result.error) {
      setError(result.error.message ?? t('authenticationFailed'))
      return
    }

    router.push('/')
    router.refresh()
  }

  const isSignUp = mode === 'sign-up'
  let credentialAutoComplete = 'current-password'
  if (isSignUp) credentialAutoComplete = 'new-password'

  return (
    <div className="row justify-content-center">
      <div className="col-md-6 col-lg-4">
        <h1>{t(isSignUp ? 'createAccount' : 'signIn')}</h1>
        <form onSubmit={onSubmit}>
          {isSignUp && (
            <div className="mb-3">
              <label htmlFor="name" className="form-label">{t('name')}</label>
              <input
                id="name"
                name="name"
                className="form-control"
                autoComplete="name"
                required
              />
            </div>
          )}
          <div className="mb-3">
            <label htmlFor="email" className="form-label">{t('email')}</label>
            <input
              id="email"
              name="email"
              type="email"
              className="form-control"
              autoComplete="email"
              required
            />
          </div>
          <div className="mb-3">
            <label htmlFor="password" className="form-label">{t('password')}</label>
            <input
              id="password"
              name="password"
              type="password"
              className="form-control"
              autoComplete={credentialAutoComplete}
              minLength={8}
              required
            />
          </div>
          {error && <div className="alert alert-danger" role="alert">{error}</div>}
          <button className="btn btn-primary w-100" type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('pleaseWait') : t(isSignUp ? 'createAccount' : 'signIn')}
          </button>
        </form>
        <p className="mt-3 text-center">
          {isSignUp ? (
            <>{t('alreadyHaveAccount')} <Link href="/sign-in">{t('signIn')}</Link></>
          ) : signUpEnabled && (
            <>{t('needAccount')} <Link href="/sign-up">{t('createOne')}</Link></>
          )}
        </p>
      </div>
    </div>
  )
}
