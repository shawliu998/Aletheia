export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "zh-CN";

export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  if (locale?.toLowerCase().startsWith("en")) return "en-US";
  return DEFAULT_LOCALE;
}
