import { languageKey } from "./languageKey";

export function setLanguage(language: string) {
  window.localStorage.setItem(languageKey, language)
}
