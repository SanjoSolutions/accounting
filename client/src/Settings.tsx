import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInputStateHandler } from './useInputStateHandler.js'

const accountId = '1'

export function Settings(): any {
  const { t } = useTranslation('Settings')

  const [isLoading, setIsLoading] = useState(true)
  const [isFirstRender, setIsFirstRender] = useState(true)
  const [name, setName, onNameChange] = useInputStateHandler('')
  const [streetAndHouseNumber, setStreetAndHouseNumber, onStreetAndHouseNumberChange] = useInputStateHandler('')
  const [zipCode, setZipCode, onZipCodeChange] = useInputStateHandler('')
  const [city, setCity, onCityChange] = useInputStateHandler('')
  const [country, setCountry, onCountryChange] = useInputStateHandler('')
  const nameElement = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    async function loadData() {
      const response = await window.api.get(`http://localhost/settings/${ accountId }`)
      const { data } = JSON.parse(await response.text())
      const { invoiceIssuer } = data
      const { name, streetAndHouseNumber, zipCode, city, country } = invoiceIssuer
      setName(name)
      setStreetAndHouseNumber(streetAndHouseNumber)
      setZipCode(zipCode)
      setCity(city)
      setCountry(country)
      setIsLoading(false)
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

      await window.api.put('/settings', {
        invoiceIssuer: {
          name,
          streetAndHouseNumber,
          zipCode,
          city,
          country,
        },
      })
    },
    [
      name,
      streetAndHouseNumber,
      zipCode,
      city,
      country,
    ],
  )

  return (
    <div>
      {
        isLoading ?
          <div>
            Loading...
          </div> :
          <form onSubmit={ onSubmit }>
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

            <div className="text-end">
              <button className="btn btn-primary" type="submit">{ t('Save') }</button>
            </div>
          </form>
      }
    </div>
  )
}
