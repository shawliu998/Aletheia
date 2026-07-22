"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/app/lib/utils";

type PillButtonTone = "black" | "white" | "blue" | "danger";
type PillButtonSize = "sm" | "normal";

type PillButtonProps = React.ComponentProps<"button"> & {
    asChild?: boolean;
    tone: PillButtonTone;
    size?: PillButtonSize;
};

const toneClasses: Record<PillButtonTone, string> = {
    black: "border-gray-950 bg-gray-950 text-white shadow-sm hover:border-gray-800 hover:bg-gray-800 disabled:hover:border-gray-950 disabled:hover:bg-gray-950",
    white: "border-gray-200 bg-white text-gray-700 shadow-none hover:border-gray-300 hover:bg-gray-50 disabled:hover:border-gray-200 disabled:hover:bg-white",
    blue: "border-blue-600 bg-blue-600 text-white shadow-sm hover:border-blue-700 hover:bg-blue-700 disabled:hover:border-blue-600 disabled:hover:bg-blue-600",
    danger: "border-red-600 bg-red-600 text-white shadow-sm hover:border-red-700 hover:bg-red-700 disabled:hover:border-red-600 disabled:hover:bg-red-600",
};

const sizeClasses: Record<PillButtonSize, string> = {
    sm: "px-2 py-1 text-xs",
    normal: "px-4 py-1.5 text-sm",
};

export function PillButton({
    asChild = false,
    tone,
    size = "sm",
    type = "button",
    className,
    ...props
}: PillButtonProps) {
    const Comp = asChild ? Slot : "button";

    return (
        <Comp
            type={asChild ? undefined : type}
            className={cn(
                "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40",
                toneClasses[tone],
                sizeClasses[size],
                className,
            )}
            {...props}
        />
    );
}
