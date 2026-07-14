import type { SupportedLocale } from "./locales.ts";

export type DateInput = Date | number | string;

function asValidDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(
  value: DateInput,
  locale: SupportedLocale,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  const date = asValidDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatNumber(
  value: number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, options).format(value);
}

const FILE_SIZE_UNITS = [
  "byte",
  "kilobyte",
  "megabyte",
  "gigabyte",
  "terabyte",
] as const;

export interface FileSizeFormatOptions {
  maximumFractionDigits?: number;
  unitDisplay?: "long" | "short" | "narrow";
}

export function formatFileSize(
  bytes: number,
  locale: SupportedLocale,
  options: FileSizeFormatOptions = {},
): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";

  const exponent = bytes === 0
    ? 0
    : Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        FILE_SIZE_UNITS.length - 1,
      );
  const value = bytes / 1024 ** exponent;

  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: FILE_SIZE_UNITS[exponent],
    unitDisplay: options.unitDisplay ?? "short",
    maximumFractionDigits: options.maximumFractionDigits ?? (exponent === 0 ? 0 : 1),
  }).format(value);
}
