import { languageKey } from "./languageKey";

export function getLanguage(): string | null {
  return window.localStorage.getItem(languageKey) ?? null
}
