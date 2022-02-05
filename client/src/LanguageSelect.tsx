import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { setLanguage } from "./setLanguage"

export function LanguageSelect(): any {
  const { t, i18n } = useTranslation('LanguageSelect')

  const onChange = useCallback(
    (event) => {
      const language = event.target.value
      i18n.changeLanguage(language)
      setLanguage(language)
    },
    [
      i18n
    ]
  )

  return (
    <select className="form-select d-inline-block w-auto" aria-label="Language select" value={i18n.language} onChange={ onChange }>
      {
        Object.keys(i18n.options.resources!).map(
          languageCode => <option key={languageCode} value={languageCode}>{ t(languageCode) }</option>
        )
      }
    </select>
  )
}
