"use client";

import { use } from "react";
import { ProjectDocumentsView } from "@/app/components/projects/ProjectDocumentsView";

export default function MatterDocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ProjectDocumentsView projectId={id} />;
}
