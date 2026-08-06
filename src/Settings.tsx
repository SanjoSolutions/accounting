"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useInputStateHandler } from './useInputStateHandler'
import { api, getJSON } from './Requester'
import {
  chartOfAccountsStandards,
  chartOfAccountsStandardLabel,
  type ChartOfAccountsStandard,
} from './core/ChartOfAccounts'

export function Settings(): any {
  const t = useTranslations('Settings')

  const [isLoading, setIsLoading] = useState(true)
  const [isFirstRender, setIsFirstRender] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saveStatus, setSaveStatus] = useState('')
  const [name, setName, onNameChange] = useInputStateHandler('')
  const [streetAndHouseNumber, setStreetAndHouseNumber, onStreetAndHouseNumberChange] = useInputStateHandler('')
  const [zipCode, setZipCode, onZipCodeChange] = useInputStateHandler('')
  const [city, setCity, onCityChange] = useInputStateHandler('')
  const [country, setCountry, onCountryChange] = useInputStateHandler('')
  const [contactName, setContactName, onContactNameChange] = useInputStateHandler('')
  const [contactTelephone, setContactTelephone, onContactTelephoneChange] = useInputStateHandler('')
  const [contactEmail, setContactEmail, onContactEmailChange] = useInputStateHandler('')
  const [chartOfAccounts, setChartOfAccounts, onChartOfAccountsChange] =
    useInputStateHandler<ChartOfAccountsStandard>('SKR03')
  const [reverseChargeInputAccount, setReverseChargeInputAccount, onReverseChargeInputAccountChange] = useInputStateHandler('')
  const [reverseChargeOutputAccount, setReverseChargeOutputAccount, onReverseChargeOutputAccountChange] = useInputStateHandler('')
  const [euAcquisitionInputAccount, setEuAcquisitionInputAccount, onEuAcquisitionInputAccountChange] = useInputStateHandler('')
  const [euAcquisitionOutputAccount, setEuAcquisitionOutputAccount, onEuAcquisitionOutputAccountChange] = useInputStateHandler('')
  const nameElement = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    async function loadData() {
      try {
        const data = await readSettingsResponse(await api.get('/api/settings'))
        const { name, streetAndHouseNumber, zipCode, city, country, contactName, contactTelephone, contactEmail } = data.invoiceIssuer
        setName(name)
        setStreetAndHouseNumber(streetAndHouseNumber)
        setZipCode(zipCode)
        setCity(city)
        setCountry(country)
        setContactName(contactName ?? '')
        setContactTelephone(contactTelephone ?? '')
        setContactEmail(contactEmail ?? '')
        setChartOfAccounts(data.chartOfAccounts ?? 'SKR03')
        setReverseChargeInputAccount(data.incomingReverseChargeAccounts ? String(data.incomingReverseChargeAccounts.inputVatAccountNumber) : '')
        setReverseChargeOutputAccount(data.incomingReverseChargeAccounts ? String(data.incomingReverseChargeAccounts.outputVatAccountNumber) : '')
        setEuAcquisitionInputAccount(data.incomingEuAcquisitionAccounts ? String(data.incomingEuAcquisitionAccounts.inputVatAccountNumber) : '')
        setEuAcquisitionOutputAccount(data.incomingEuAcquisitionAccounts ? String(data.incomingEuAcquisitionAccounts.outputVatAccountNumber) : '')
      } catch {
        setLoadError(t('Load failed'))
      } finally {
        setIsLoading(false)
      }
    }

    if (isFirstRender) {
      // nameElement.current!.focus()
      loadData()

      setIsFirstRender(false)
    }
  }, [isFirstRender])

  const onSubmit = useCallback(
    async (event: any) => {
      event.preventDefault()
      setSaveError(''); setSaveStatus('')
      try {
        const response = await api.put('/api/settings', {
          invoiceIssuer: { name, streetAndHouseNumber, zipCode, city, country, contactName, contactTelephone, contactEmail },
          chartOfAccounts,
          ...(reverseChargeInputAccount || reverseChargeOutputAccount ? { incomingReverseChargeAccounts: { chart: chartOfAccounts, rateBasisPoints: 1900, inputVatAccountNumber: Number(reverseChargeInputAccount), outputVatAccountNumber: Number(reverseChargeOutputAccount) } } : {}),
          ...(euAcquisitionInputAccount || euAcquisitionOutputAccount ? { incomingEuAcquisitionAccounts: { chart: chartOfAccounts, rateBasisPoints: 1900, inputVatAccountNumber: Number(euAcquisitionInputAccount), outputVatAccountNumber: Number(euAcquisitionOutputAccount) } } : {}),
        })
        if (!response.ok) throw new Error(response.status === 403 ? 'Your role does not permit changes.' : 'Settings could not be saved.')
        setSaveStatus('Settings saved.')
      } catch (error) { setSaveError(error instanceof Error ? error.message : 'Settings could not be saved.') }
    },
    [
      name,
      streetAndHouseNumber,
      zipCode,
      city,
      country,
      contactName,
      contactTelephone,
      contactEmail,
      chartOfAccounts,
      reverseChargeInputAccount,
      reverseChargeOutputAccount,
      euAcquisitionInputAccount,
      euAcquisitionOutputAccount,
    ],
  )

  return (
    <div>
      {
        isLoading ?
          <div>
            Loading...
          </div> :
          loadError ? <div className="alert alert-danger" role="alert">{loadError}</div> :
          <form onSubmit={ onSubmit }>
            {saveError && <p className="alert alert-danger" role="alert">{saveError}</p>}
            {saveStatus && <p className="alert alert-success" role="status">{saveStatus}</p>}
            <fieldset>
              <legend>{ t('Invoice issuer') }</legend>

              <div className="mb-3">
                <label htmlFor="name" className="form-label">{ t('Name') }</label>
                <input
                  type="text"
                  className="form-control"
                  id="name"
                  ref={ nameElement }
                  value={ name }
                  onChange={ onNameChange }
                />
              </div>
              <div className="mb-3"><label htmlFor="contactName" className="form-label">{ t('Contact name') }</label><input type="text" className="form-control" id="contactName" value={contactName} onChange={onContactNameChange} /></div>
              <div className="mb-3"><label htmlFor="contactTelephone" className="form-label">{ t('Contact telephone') }</label><input type="tel" className="form-control" id="contactTelephone" value={contactTelephone} onChange={onContactTelephoneChange} /></div>
              <div className="mb-3"><label htmlFor="contactEmail" className="form-label">{ t('Contact email') }</label><input type="email" className="form-control" id="contactEmail" value={contactEmail} onChange={onContactEmailChange} /></div>

              <div className="mb-3">
                <label htmlFor="streetAndHouseNumber" className="form-label">{ t('Street and house number') }</label>
                <input
                  type="text"
                  className="form-control"
                  id="streetAndHouseNumber"
                  value={ streetAndHouseNumber }
                  onChange={ onStreetAndHouseNumberChange }
                />
              </div>

              <div className="mb-3">
                <label htmlFor="zipCode" className="form-label">{ t('Zip code') }</label>
                <input
                  type="text"
                  className="form-control"
                  id="zipCode"
                  value={ zipCode }
                  onChange={ onZipCodeChange }
                />
              </div>

              <div className="mb-3">
                <label htmlFor="city" className="form-label">{ t('City') }</label>
                <input type="text" className="form-control" id="city" value={ city } onChange={ onCityChange } />
              </div>

              <div className="mb-3">
                <label htmlFor="country" className="form-label">{ t('Country') }</label>
                <input
                  type="text"
                  className="form-control"
                  id="country"
                  value={ country }
                  onChange={ onCountryChange }
                />
              </div>
            </fieldset>

            <fieldset className="mb-3">
              <legend>{ t('Accounting') }</legend>

              <label htmlFor="chartOfAccounts" className="form-label">{ t('Chart of accounts') }</label>
              <select
                className="form-select"
                id="chartOfAccounts"
                value={ chartOfAccounts }
                onChange={ onChartOfAccountsChange }
              >
                { chartOfAccountsStandards.map((standard) => (
                  <option key={ standard } value={ standard }>
                    { chartOfAccountsStandardLabel(standard) }
                  </option>
                )) }
              </select>
              <div className="mt-3"><p className="form-text">{t('Reverse charge hint')}</p>
                <label htmlFor="reverseChargeInputAccount" className="form-label">{t('Reverse charge input account')}</label>
                <input id="reverseChargeInputAccount" className="form-control" inputMode="numeric" pattern="[0-9]+" value={reverseChargeInputAccount} onChange={onReverseChargeInputAccountChange} />
                <label htmlFor="reverseChargeOutputAccount" className="form-label mt-2">{t('Reverse charge output account')}</label>
                <input id="reverseChargeOutputAccount" className="form-control" inputMode="numeric" pattern="[0-9]+" value={reverseChargeOutputAccount} onChange={onReverseChargeOutputAccountChange} />
              </div>
              <div className="mt-3"><p className="form-text">{t('EU acquisition hint')}</p>
                <label htmlFor="euAcquisitionInputAccount" className="form-label">{t('EU acquisition input account')}</label>
                <input id="euAcquisitionInputAccount" className="form-control" inputMode="numeric" pattern="[0-9]+" value={euAcquisitionInputAccount} onChange={onEuAcquisitionInputAccountChange} />
                <label htmlFor="euAcquisitionOutputAccount" className="form-label mt-2">{t('EU acquisition output account')}</label>
                <input id="euAcquisitionOutputAccount" className="form-control" inputMode="numeric" pattern="[0-9]+" value={euAcquisitionOutputAccount} onChange={onEuAcquisitionOutputAccountChange} />
              </div>
            </fieldset>

            <div className="text-end">
              <button className="btn btn-primary" type="submit">{ t('Save') }</button>
            </div>
          </form>
      }
    </div>
  )
}

export async function readSettingsResponse(response: Response): Promise<{
  invoiceIssuer: { name: string; streetAndHouseNumber: string; zipCode: string; city: string; country: string; contactName?: string; contactTelephone?: string; contactEmail?: string }
  chartOfAccounts?: ChartOfAccountsStandard
  incomingReverseChargeAccounts?: { chart: ChartOfAccountsStandard; rateBasisPoints: 1900; inputVatAccountNumber: number; outputVatAccountNumber: number }
  incomingEuAcquisitionAccounts?: { chart: ChartOfAccountsStandard; rateBasisPoints: 1900; inputVatAccountNumber: number; outputVatAccountNumber: number }
}> {
  const body = await getJSON(response)
  if (!response.ok || !body?.data || typeof body.data !== 'object' || !body.data.invoiceIssuer) {
    throw new Error('Settings could not be loaded.')
  }
  return body.data
}
