"use client";

import { use } from "react";
import { DocumentStudioView } from "@/app/components/projects/DocumentStudioView";

export default function ProjectDocumentStudioPage({
  params,
}: {
  params: Promise<{ id: string; documentId: string }>;
}) {
  const { id, documentId } = use(params);
  return <DocumentStudioView projectId={id} documentId={documentId} />;
}
