import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { changeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/lib/i18n";

interface Props {
  className?: string;
}

/** Discreet manual language switcher; auto-detected language stays the default. */
export function LanguageSwitcher({ className }: Props) {
  const { t, i18n } = useTranslation();
  // SSR and the first client render are always English (see lib/i18n.ts); this component's
  // own hydration can settle later than the effect that applies the detected language (Radix's
  // Select content hydrates on its own schedule), so it keeps showing the SSR-matching English
  // label until it has locally confirmed it is mounted, rather than trusting the global
  // language the moment it becomes available.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = mounted
    ? ((i18n.resolvedLanguage ?? i18n.language ?? "en").slice(0, 2) as SupportedLanguage)
    : "en";

  return (
    <Select value={current} onValueChange={changeLanguage}>
      <SelectTrigger
        className={className ?? "h-8 w-[4.5rem] gap-1 px-2 text-xs"}
        aria-label={mounted ? t("common.language") : "Language"}
      >
        <Languages className="h-3.5 w-3.5 shrink-0" />
        <SelectValue>{current.toUpperCase()}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {SUPPORTED_LANGUAGES.map((lng) => (
          <SelectItem key={lng} value={lng} className="text-xs">
            {t(`common.languages.${lng}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
