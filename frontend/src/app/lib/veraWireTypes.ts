/**
 * Vera's public transport contracts.
 *
 * These types deliberately mirror the locked Mike e32daad wire format. They
 * stay snake_case at the HTTP boundary; UI/domain adapters can map them to a
 * different convention without leaking transport details across the app.
 */

export type VeraFileTypeWire =
  | "pdf"
  | "docx"
  | "doc"
  | "xlsx"
  | "xlsm"
  | "xls"
  | "pptx"
  | "ppt"
  | "txt"
  | "md";

export interface VeraFolderWire {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VeraDocumentStudioCapabilityWire {
  editable: boolean;
  format: "markdown" | null;
  docx_import: boolean;
  docx_export: boolean;
}

export interface VeraDocumentOcrSummaryWire {
  engine: "apple-vision";
  ocr_page_count: number;
  /** Bounded to the first 50 low-confidence OCR pages. */
  low_confidence_pages: number[];
  low_confidence_page_count: number;
  low_confidence_pages_truncated: boolean;
  review_required: boolean;
}

export interface VeraDocumentWire {
  id: string;
  user_id: string;
  project_id: string | null;
  folder_id: string | null;
  filename: string;
  owner_email: string | null;
  owner_display_name: string | null;
  file_type: VeraFileTypeWire | null;
  /** Local storage locations are never exposed over the public boundary. */
  storage_path: null;
  pdf_storage_path: "local-preview" | null;
  size_bytes: number | null;
  page_count: number | null;
  structure_tree: null;
  status: "pending" | "processing" | "ready" | "error";
  created_at: string | null;
  updated_at: string | null;
  active_version_number: number | null;
  latest_version_number: number | null;
  /** Current-version OCR review signal; absent only in older embedded projections. */
  ocr_summary?: VeraDocumentOcrSummaryWire | null;
  /** Absent on older runtimes; absence is treated as no Studio access. */
  studio_capability?: VeraDocumentStudioCapabilityWire;
}

export interface VeraProjectWire {
  id: string;
  user_id: string;
  name: string;
  /** Vera local extension: Project is the generic workspace container. */
  description: string | null;
  cm_number: string | null;
  practice: string | null;
  shared_with: string[];
  created_at: string;
  updated_at: string;
  is_owner: boolean;
  owner_display_name: string | null;
  owner_email: string | null;
  documents: VeraDocumentWire[];
  folders: VeraFolderWire[];
  document_count: number;
  chat_count: number;
  review_count: number;
  workflow_count: number;
  status: "active" | "archived" | "deleted";
  archived_at: string | null;
  default_model_profile_id: string | null;
}

export interface VeraDocumentVersionWire {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  filename: string | null;
  file_type?: VeraFileTypeWire | null;
  size_bytes?: number | null;
  page_count?: number | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
}

export interface VeraDocumentVersionsWire {
  current_version_id: string | null;
  versions: VeraDocumentVersionWire[];
}

export type VeraJobStatusWire =
  "queued" | "running" | "complete" | "failed" | "cancelled" | "interrupted";

/** Safe public projection of a document parse job. */
export interface VeraDocumentJobWire {
  id: string;
  type: "document_parse";
  status: VeraJobStatusWire;
  attempt: number;
  max_attempts: number;
  retryable: boolean;
  created_at: string;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface VeraDocumentMutationWire {
  document: VeraDocumentWire;
  version: VeraDocumentVersionWire;
  job: VeraDocumentJobWire;
}

export interface VeraDocumentRetryWire {
  job: VeraDocumentJobWire;
}

export interface VeraDocumentReadWire {
  document_id: string;
  version_id?: string | null;
  content: string;
}

export interface VeraDownloadCapabilityWire {
  /** Opaque, short-lived local capability. Never persist either URL. */
  url: string;
  document_id: string;
  filename: string;
  version_id: string | null;
  has_pdf_rendition: boolean;
  download_url?: string;
}

export interface VeraChatWire {
  id: string;
  project_id: string | null;
  user_id: string;
  creator_display_name: string | null;
  title: string | null;
  created_at: string;
}

export interface VeraDocumentCitationQuoteWire {
  page: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
}

export interface VeraDocumentCitationWire {
  type: "citation_data";
  kind: "document";
  ref: number;
  /** Mike's model-visible document label, not a database identifier. */
  doc_id: string;
  document_id: string;
  filename: string;
  quote: string;
  page: number | string;
  version_id?: string | null;
  version_number?: number | null;
  sheet?: string;
  cell?: string;
  quotes?: VeraDocumentCitationQuoteWire[];
}

export type VeraAssistantEventWire =
  | { type: "reasoning" | "content"; text: string; isStreaming?: boolean }
  | { type: "error"; message: string }
  | { type: "thinking"; isStreaming?: boolean }
  | { type: "tool_call_start"; name: string; isStreaming?: boolean }
  | {
      type: "ask_inputs";
      items: Array<
        | {
            id: string;
            kind: "choice";
            question: string;
            options: Array<{ value: string }>;
            allow_other: boolean;
            other_label: string;
            response_prefix?: string;
          }
        | {
            id: string;
            kind: "documents";
            document_types: string[];
            response_prefix?: string;
          }
      >;
    }
  | {
      type: "ask_inputs_response";
      responses: Array<
        | {
            id: string;
            kind: "choice";
            question: string;
            answer?: string;
            skipped?: boolean;
          }
        | {
            id: string;
            kind: "documents";
            filenames: string[];
            skipped?: boolean;
          }
      >;
    }
  | {
      type: "doc_read";
      filename: string;
      document_id?: string;
      isStreaming?: boolean;
    }
  | {
      type: "doc_find";
      filename: string;
      query: string;
      total_matches: number;
      isStreaming?: boolean;
    }
  | {
      type: "doc_created";
      filename: string;
      download_url: string;
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
      isStreaming?: boolean;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
      type: "doc_replicated";
      filename: string;
      count: number;
      copies?: Array<{
        new_filename: string;
        document_id: string;
        version_id: string;
      }>;
      error?: string;
      isStreaming?: boolean;
    }
  | {
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      version_number?: number | null;
      download_url: string;
      annotations: Array<{
        edit_id: string;
        document_id: string;
        version_id: string;
        change_id: string;
        del_w_id: string;
        ins_w_id: string;
        deleted_text: string;
        inserted_text: string;
        status: "pending" | "accepted" | "rejected";
      }>;
      error?: string;
      isStreaming?: boolean;
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "task_plan";
      plan_id: string;
      goal: string;
      steps: Array<{
        id: string;
        title: string;
        status: "pending" | "in_progress" | "completed" | "failed";
      }>;
      deliverables?: Array<{
        kind: "tabular_review" | "review" | "xlsx" | "draft" | "docx";
        label: string;
        status: "pending" | "completed";
        artifact_id?: string;
        route?: string;
      }>;
    }
  | {
      type: "task_step_update";
      plan_id: string;
      step_id: string;
      status: "in_progress" | "completed" | "failed";
      detail?: string;
    };

export interface VeraMessageWire {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | VeraAssistantEventWire[] | null;
  files: Array<{ filename: string; document_id?: string }>;
  citations: VeraDocumentCitationWire[];
  created_at: string;
}

export interface VeraChatDetailWire {
  chat: VeraChatWire;
  messages: VeraMessageWire[];
}

export type VeraColumnFormatWire =
  | "text"
  | "bulleted_list"
  | "number"
  | "percentage"
  | "monetary_amount"
  | "currency"
  | "yes_no"
  | "date"
  | "tag";

export interface VeraColumnConfigWire {
  index: number;
  name: string;
  prompt: string;
  format: VeraColumnFormatWire;
  tags: string[];
}

export interface VeraWorkflowContributorWire {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
}

export interface VeraWorkflowWire {
  id: string;
  user_id: string | null;
  metadata: {
    title: string;
    description: string | null;
    type: "assistant" | "tabular";
    contributors: VeraWorkflowContributorWire[];
    language: string;
    version: string | null;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  columns_config: VeraColumnConfigWire[] | null;
  is_system: boolean;
  created_at: string;
  shared_by_name: string | null;
  allow_edit: boolean;
  is_owner: boolean;
  open_source_submission: null;
}

export interface VeraTabularReviewWire {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  columns_config: VeraColumnConfigWire[] | null;
  document_ids: string[] | null;
  workflow_id: string | null;
  practice?: string | null;
  shared_with: string[];
  is_owner: boolean;
  created_at: string;
  updated_at: string;
  document_count: number;
}

export interface VeraTabularCellWire {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
  created_at: string;
}

export interface VeraTabularReviewDetailWire {
  review: VeraTabularReviewWire;
  cells: VeraTabularCellWire[];
  documents: VeraDocumentWire[];
}

/**
 * Streaming events preserve Mike's exact field names. `chatId` is the one
 * intentional camelCase exception in the locked upstream protocol.
 */
export type VeraSseEventWire =
  | { type: "chat_id"; chatId: string }
  | { type: "content_delta"; text: string }
  | { type: "content_done" }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_block_end" }
  | { type: "tool_call_start"; name: string }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "citations";
      status: "started" | "partial" | "final";
      citations: VeraDocumentCitationWire[];
    }
  | { type: "error"; message: string }
  | {
      type: "cell_update";
      document_id: string;
      column_index: number;
      content: {
        summary: string;
        flag?: "green" | "grey" | "yellow" | "red";
        reasoning?: string;
      } | null;
      status: "generating" | "done" | "error";
    }
  | { type: "chat_title"; chatId: string; title: string };

export interface VeraApiErrorWire {
  detail?: unknown;
  code?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
}

export interface VeraProjectCreateWire {
  name: string;
  description?: string | null;
  cm_number?: string | null;
  practice?: string | null;
  shared_with?: string[];
}

export interface VeraProjectUpdateWire {
  name?: string;
  description?: string | null;
  cm_number?: string | null;
  practice?: string | null;
}

export interface VeraFolderCreateWire {
  name: string;
  parent_folder_id?: string | null;
}

export interface VeraFolderUpdateWire {
  name?: string;
  parent_folder_id?: string | null;
}
