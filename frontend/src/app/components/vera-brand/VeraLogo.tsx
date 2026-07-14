import { VeraMark } from "./VeraMark";

export type VeraLogoSize = "sm" | "md" | "lg" | "xl";

export interface VeraLogoProps {
  size?: VeraLogoSize;
  className?: string;
  label?: string;
  priority?: boolean;
}

const SIZES: Record<
  VeraLogoSize,
  { mark: number; textClassName: string; gapClassName: string }
> = {
  sm: { mark: 20, textClassName: "text-base", gapClassName: "gap-1.5" },
  md: { mark: 28, textClassName: "text-xl", gapClassName: "gap-2" },
  lg: { mark: 40, textClassName: "text-3xl", gapClassName: "gap-2.5" },
  xl: { mark: 56, textClassName: "text-5xl", gapClassName: "gap-3" },
};

export function VeraLogo({
  size = "md",
  className = "",
  label = "Vera",
  priority = false,
}: VeraLogoProps) {
  const dimensions = SIZES[size];

  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-flex items-center ${dimensions.gapClassName} ${className}`}
    >
      <VeraMark size={dimensions.mark} decorative priority={priority} />
      <span
        aria-hidden="true"
        className={`${dimensions.textClassName} font-semibold leading-none tracking-tight`}
      >
        Vera
      </span>
    </span>
  );
}
