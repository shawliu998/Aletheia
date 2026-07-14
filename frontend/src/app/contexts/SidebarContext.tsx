"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/contexts/SidebarContext.tsx
import { createContext, useContext } from "react";

interface SidebarContextValue {
    setSidebarOpen: (open: boolean) => void;
}

export const SidebarContext = createContext<SidebarContextValue>({
    setSidebarOpen: () => {},
});

export function useSidebar() {
    return useContext(SidebarContext);
}
