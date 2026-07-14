import Image from "next/image";

export interface VeraMarkProps {
  size?: number;
  className?: string;
  decorative?: boolean;
  label?: string;
  priority?: boolean;
}

export function VeraMark({
  size = 28,
  className,
  decorative = false,
  label = "Vera",
  priority = false,
}: VeraMarkProps) {
  return (
    <Image
      src="/vera-mark.png"
      width={size}
      height={size}
      alt={decorative ? "" : label}
      aria-hidden={decorative || undefined}
      className={className}
      draggable={false}
      priority={priority}
    />
  );
}
