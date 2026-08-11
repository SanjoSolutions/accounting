import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import deMessages from '../messages/de.json'
import enMessages from '../messages/en.json'

const readSource = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

describe('authentication and access copy', () => {
  test('provides concise English and German authentication labels and fallbacks', () => {
    expect(enMessages.Authentication).toMatchObject({
      createAccount: 'Create account',
      signIn: 'Sign in',
      pleaseWait: 'Please wait…',
      authenticationFailed: 'Authentication failed.',
    })
    expect(deMessages.Authentication).toMatchObject({
      createAccount: 'Konto erstellen',
      signIn: 'Anmelden',
      pleaseWait: 'Bitte warten …',
      authenticationFailed: 'Anmeldung fehlgeschlagen.',
    })
  })

  test('wires every authentication-facing literal through the translation namespace', () => {
    const source = readSource('./AuthenticationForm.tsx')
    expect(source).toContain("useTranslations('Authentication')")
    for (const literal of ['Create account', 'Sign in', 'Please wait…', 'Authentication failed.', 'Already have an account?', 'Need an account?']) expect(source).not.toContain(literal)
  })

  test('provides navigation and access role copy in both locales', () => {
    expect(enMessages.Navbar).toMatchObject({ toggleNavigation: 'Toggle navigation', signOut: 'Sign out', signIn: 'Sign in', createAccount: 'Create account' })
    expect(deMessages.Navbar).toMatchObject({ toggleNavigation: 'Navigation ein- oder ausblenden', signOut: 'Abmelden', signIn: 'Anmelden', createAccount: 'Konto erstellen' })
    expect(enMessages.Access.roles).toEqual({ ADMIN: 'Administrator', ACCOUNTANT: 'Accountant', READ_ONLY: 'Read only' })
    expect(deMessages.Access.roles).toEqual({ ADMIN: 'Administrator', ACCOUNTANT: 'Buchhalter', READ_ONLY: 'Nur Lesen' })
  })

  test('keeps navbar and access fallbacks localized without raw role labels', () => {
    const navbar = readSource('./Navbar.tsx')
    const access = readSource('./AccessWorkspace.tsx')
    expect(navbar).toContain("aria-label={t('toggleNavigation')}")
    expect(navbar).toContain("t('signOutFailed')")
    for (const literal of ['Toggle navigation', 'Sign out', 'Sign in', 'Create account', 'Sign out failed.']) expect(navbar).not.toContain(literal)
    expect(access).toContain("useTranslations('Access')")
    expect(access).toContain('t(`roles.${member.role}`)')
    for (const literal of ['Users and roles', 'Loading access settings…', 'Use this company', 'Save access']) expect(access).not.toContain(literal)
  })
})
