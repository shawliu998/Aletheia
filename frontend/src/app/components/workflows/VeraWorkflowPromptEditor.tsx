"use client";

import {
  VeraRichTextEditor,
  type VeraRichTextEditorProps,
} from "@/app/components/shared/VeraRichTextEditor";

/** Workflow compatibility wrapper around Vera's shared rich-text editor. */
export function VeraWorkflowPromptEditor(props: VeraRichTextEditorProps) {
  return <VeraRichTextEditor {...props} />;
}
