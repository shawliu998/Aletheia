"use client";

// UI composition ported from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/InitialView.tsx
import { VeraMark } from "@/app/components/vera-brand";
import { useRef } from "react";
import type { Message } from "@/app/components/shared/types";
import type { VeraDocumentWire } from "@/app/lib/veraWireTypes";
import { useI18n } from "@/app/i18n";
import { AssistantStarterPanel } from "./AssistantStarterPanel";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

export function InitialView({
  onSubmit,
  availableDocuments,
  projectName,
  error,
}: {
  onSubmit: (message: Message) => void | Promise<unknown>;
  availableDocuments?: readonly VeraDocumentWire[];
  projectName?: string | null;
  error?: string | null;
}) {
  const { t } = useI18n();
  const chatInputRef = useRef<ChatInputHandle>(null);
  const readyDocumentCount =
    availableDocuments?.filter((document) => document.status === "ready")
      .length ?? 0;

  return (
    <div className="flex h-full w-full flex-col px-6">
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="relative w-full max-w-4xl px-0 xl:px-8">
          <div className="mb-10 flex items-center justify-center gap-3">
            <VeraMark size={30} decorative priority />
            <h1 className="whitespace-nowrap font-serif text-4xl font-light text-gray-900">
              {projectName ?? t("assistant.empty.title")}
            </h1>
          </div>
          <div className="mb-5 flex justify-center">
            <AssistantStarterPanel
              inputRef={chatInputRef}
              scopeAvailable={availableDocuments !== undefined}
              showReadyHint={readyDocumentCount < 2}
            />
          </div>
          <ChatInput
            ref={chatInputRef}
            onSubmit={onSubmit}
            onCancel={() => undefined}
            isLoading={false}
            availableDocuments={availableDocuments}
            projectName={projectName}
          />
          {error && (
            <p role="alert" className="pt-3 text-center text-xs text-red-600">
              {error}
            </p>
          )}
          <p className="py-3 text-center text-xs text-gray-500">
            {t("assistant.disclaimer")}
          </p>
        </div>
      </div>
    </div>
  );
}
