"use client";

import { createContext, type ReactNode, useContext } from "react";

export type WorkspaceRouteKind = "project" | "matter";

export interface WorkspaceRouteAdapter {
  kind: WorkspaceRouteKind;
  collectionHref: string;
  workspaceHref: (projectId: string) => string;
  documentsHref: (projectId: string) => string;
  documentStudioHref: (projectId: string, documentId: string) => string;
  assistantHref: (projectId: string) => string;
  assistantChatHref: (projectId: string, chatId: string) => string;
  workflowsHref: (projectId: string) => string;
  workflowHref: (projectId: string, workflowId: string) => string;
  tabularReviewsHref: (projectId: string) => string;
  tabularReviewHref: (projectId: string, reviewId: string) => string;
  settingsHref: (projectId: string) => string;
}

export const PROJECT_WORKSPACE_ROUTES: WorkspaceRouteAdapter = {
  kind: "project",
  collectionHref: "/projects",
  workspaceHref: (projectId) => `/projects/${projectId}`,
  documentsHref: (projectId) => `/projects/${projectId}`,
  documentStudioHref: (projectId, documentId) =>
    `/projects/${projectId}/documents/${documentId}/studio`,
  assistantHref: (projectId) => `/projects/${projectId}/assistant`,
  assistantChatHref: (projectId, chatId) =>
    `/projects/${projectId}/assistant/chat/${chatId}`,
  workflowsHref: (projectId) => `/projects/${projectId}/workflows`,
  workflowHref: (projectId, workflowId) =>
    `/workflows/${encodeURIComponent(workflowId)}?project_id=${encodeURIComponent(projectId)}`,
  tabularReviewsHref: (projectId) => `/projects/${projectId}/tabular-reviews`,
  tabularReviewHref: (projectId, reviewId) =>
    `/projects/${projectId}/tabular-reviews/${reviewId}`,
  settingsHref: (projectId) => `/projects/${projectId}`,
};

export const MATTER_WORKSPACE_ROUTES: WorkspaceRouteAdapter = {
  kind: "matter",
  collectionHref: "/matters",
  workspaceHref: (projectId) => `/matters/${projectId}`,
  documentsHref: (projectId) => `/matters/${projectId}/documents`,
  documentStudioHref: (projectId, documentId) =>
    `/matters/${projectId}/documents/${documentId}/studio`,
  assistantHref: (projectId) => `/matters/${projectId}/assistant`,
  assistantChatHref: (projectId, chatId) =>
    `/matters/${projectId}/assistant/chat/${chatId}`,
  workflowsHref: (projectId) => `/matters/${projectId}/workflows`,
  workflowHref: (projectId, workflowId) =>
    `/matters/${projectId}/workflows/${encodeURIComponent(workflowId)}`,
  tabularReviewsHref: (projectId) => `/matters/${projectId}/review`,
  tabularReviewHref: (projectId, reviewId) =>
    `/matters/${projectId}/review/${reviewId}`,
  settingsHref: (projectId) => `/matters/${projectId}/settings`,
};

const WorkspaceRouteContext = createContext<WorkspaceRouteAdapter>(
  PROJECT_WORKSPACE_ROUTES,
);

export function WorkspaceRouteProvider({
  adapter,
  children,
}: {
  adapter: WorkspaceRouteAdapter;
  children: ReactNode;
}) {
  return (
    <WorkspaceRouteContext.Provider value={adapter}>
      {children}
    </WorkspaceRouteContext.Provider>
  );
}

export function useWorkspaceRoutes(): WorkspaceRouteAdapter {
  return useContext(WorkspaceRouteContext);
}
