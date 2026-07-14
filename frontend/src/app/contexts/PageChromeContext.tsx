"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/contexts/PageChromeContext.tsx
import { createContext, useContext } from "react";

interface PageChromeContextValue {
    mobileActionsContainer: HTMLElement | null;
}

export const PageChromeContext = createContext<PageChromeContextValue>({
    mobileActionsContainer: null,
});

export function usePageChrome() {
    return useContext(PageChromeContext);
}
