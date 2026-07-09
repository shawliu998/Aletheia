"use client";

import { useCallback, useEffect, useState } from "react";
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from "../components/assistant/ModelToggle";
import { ALETHEIA_SETTINGS_EVENT } from "@/aletheia/settingsModel";

const STORAGE_KEY = "aletheia.selectedModel";

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && ALLOWED_MODEL_IDS.has(raw)) return raw;
    return DEFAULT_MODEL_ID;
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(readStored);

    useEffect(() => {
        function syncModel() {
            setModelState(readStored());
        }
        window.addEventListener("storage", syncModel);
        window.addEventListener(ALETHEIA_SETTINGS_EVENT, syncModel);
        return () => {
            window.removeEventListener("storage", syncModel);
            window.removeEventListener(ALETHEIA_SETTINGS_EVENT, syncModel);
        };
    }, []);

    const setModel = useCallback((id: string) => {
        const next = ALLOWED_MODEL_IDS.has(id) ? id : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return [model, setModel];
}
