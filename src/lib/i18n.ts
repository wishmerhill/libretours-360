import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "@/locales/en.json";
import it from "@/locales/it.json";

export const SUPPORTED_LANGUAGES = ["en", "it"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const DETECTION_OPTIONS = {
  order: ["localStorage", "navigator"],
  caches: ["localStorage"],
  lookupLocalStorage: "openstudio.lang",
};

// A standalone detector, deliberately not registered on the i18next instance via `.use()`:
// i18next always inits with `lng: "en"` below (so SSR and the client's first render match
// exactly, see applyDetectedLanguage), and a registered detector would cache that "en" back
// to localStorage as a side effect of init, clobbering whatever language the user had chosen.
// Client-only: it reads localStorage/navigator, neither of which exist during SSR.
const detector = typeof window !== "undefined" ? new LanguageDetector() : null;
detector?.init(undefined, DETECTION_OPTIONS);

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      it: { translation: it },
    },
    fallbackLng: "en",
    // Both SSR and the client's first render must produce identical markup, or React
    // throws a hydration mismatch and discards the server-rendered tree. So the very
    // first render is always English everywhere; applyDetectedLanguage() switches to
    // the real language right after the client mounts (an ordinary post-mount update).
    lng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

/** Client-only: switches to the saved/browser-detected language once, right after mount. */
export function applyDetectedLanguage(): void {
  if (!detector) return;
  const detected = detector.detect();
  const lang = Array.isArray(detected) ? detected[0] : detected;
  if (lang && lang !== i18n.language) changeLanguage(lang);
}

/** Changes the active language and persists the choice; the LanguageSwitcher uses this. */
export function changeLanguage(lang: string): void {
  detector?.cacheUserLanguage(lang);
  void i18n.changeLanguage(lang);
}

export default i18n;
