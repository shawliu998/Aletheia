"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  formatDate as formatDateValue,
  formatFileSize as formatFileSizeValue,
  formatNumber as formatNumberValue,
  type DateInput,
  type FileSizeFormatOptions,
} from "./formatters.ts";
import { DEFAULT_LOCALE, type SupportedLocale } from "./locales.ts";
import {
  translateMessage,
  type MessageKey,
  type Translate,
  type TranslationValues,
} from "./messages.ts";
import {
  localizeBackendError,
  type BackendErrorDescriptor,
} from "./errors.ts";

export interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: Translate;
  formatDate: (value: DateInput, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatFileSize: (bytes: number, options?: FileSizeFormatOptions) => string;
  errorMessage: (
    error: BackendErrorDescriptor | string | null | undefined,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  children: ReactNode;
  initialLocale?: SupportedLocale;
}

export function I18nProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: I18nProviderProps) {
  const [locale, setLocale] = useState<SupportedLocale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, values?: TranslationValues) =>
      translateMessage(locale, key, values),
    [locale],
  );
  const formatDate = useCallback(
    (value: DateInput, options?: Intl.DateTimeFormatOptions) =>
      formatDateValue(value, locale, options),
    [locale],
  );
  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      formatNumberValue(value, locale, options),
    [locale],
  );
  const formatFileSize = useCallback(
    (bytes: number, options?: FileSizeFormatOptions) =>
      formatFileSizeValue(bytes, locale, options),
    [locale],
  );
  const errorMessage = useCallback(
    (error: BackendErrorDescriptor | string | null | undefined) =>
      localizeBackendError(error, t),
    [t],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t,
      formatDate,
      formatNumber,
      formatFileSize,
      errorMessage,
    }),
    [errorMessage, formatDate, formatFileSize, formatNumber, locale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
