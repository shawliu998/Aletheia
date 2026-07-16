import { VeraApiError, veraApiRequest } from "./veraApi";
import { VeraRuntimeConfigurationError, type VeraQuery } from "./veraRuntime";

export const VERA_WORKSPACE_TYPES = [
  "general_legal",
  "transaction",
  "dispute",
  "investigation",
  "compliance",
  "research",
] as const;

export const VERA_MATTER_PROFILE_STATES = [
  "absent",
  "classification_required",
  "ready",
] as const;

export type VeraWorkspaceType = (typeof VERA_WORKSPACE_TYPES)[number];
export type VeraMatterProfileState =
  (typeof VERA_MATTER_PROFILE_STATES)[number];

export interface VeraMatterProjectWire {
  id: string;
  name: string;
  description: string | null;
  cm_number: string | null;
  practice: string | null;
  status: "active" | "archived" | "deleted";
  default_model_profile_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  document_count: number;
  chat_count: number;
  tabular_review_count: number;
  workflow_count: number;
}

export interface VeraMatterProfileWire {
  project_id: string;
  workspace_type: VeraWorkspaceType | null;
  client_name: string | null;
  jurisdiction: string | null;
  represented_role: string | null;
  objective: string | null;
  created_at: string;
  updated_at: string;
}

export interface VeraMatterCapabilitiesWire {
  matter_profile: "create" | "classify" | "edit" | "unavailable";
  assistant:
    | "available"
    | "require_approval"
    | "policy_gate_closed"
    | "unavailable";
  workflows:
    | "available"
    | "non_inference_only"
    | "require_approval"
    | "policy_gate_closed"
    | "unavailable";
  tabular:
    | "available"
    | "require_approval"
    | "policy_gate_closed"
    | "unavailable";
  review: "available" | "unavailable";
  drafts: "document_scoped" | "available" | "unavailable";
}

export interface VeraMatterWire {
  project: VeraMatterProjectWire;
  matter_profile: VeraMatterProfileWire | null;
  profile_state: VeraMatterProfileState;
  capabilities: VeraMatterCapabilitiesWire;
}

export interface VeraMatterPageWire {
  items: VeraMatterWire[];
  next_cursor: string | null;
}

export interface VeraMatterListQuery {
  status?: "active" | "archived";
  profile_state?: "profiled" | "ready" | "classification_required" | "absent" | "all";
  cursor?: string;
  limit?: number;
}

export interface VeraMatterProfileCreateWire {
  workspace_type: VeraWorkspaceType;
  client_name?: string | null;
  jurisdiction?: string | null;
  represented_role?: string | null;
  objective?: string | null;
}

export interface VeraMatterCreateWire extends VeraMatterProfileCreateWire {
  name: string;
  description?: string | null;
  cm_number?: string | null;
  practice?: string | null;
}

export interface VeraMatterProfileUpdateWire {
  workspace_type?: VeraWorkspaceType;
  client_name?: string | null;
  jurisdiction?: string | null;
  represented_role?: string | null;
  objective?: string | null;
}

export interface VeraMatterProjectUpdateWire {
  name?: string;
  description?: string | null;
  cm_number?: string | null;
  practice?: string | null;
}

export interface VeraMatterUpdateWire {
  project?: VeraMatterProjectUpdateWire;
  profile?: VeraMatterProfileUpdateWire;
}

export const VERA_EXECUTION_LOCATIONS = [
  "local",
  "firm_private",
  "confidential_remote",
  "standard_remote",
] as const;

export type VeraExecutionLocation = (typeof VERA_EXECUTION_LOCATIONS)[number];
export type VeraMatterExternalEgressMode =
  | "disabled"
  | "approval"
  | "allowed_by_policy";

export interface VeraMatterPolicyWire {
  project_id: string;
  external_egress_mode: VeraMatterExternalEgressMode;
  execution_locations: VeraExecutionLocation[];
  allow_external_legal_sources: boolean;
  allow_word_bridge: boolean;
  created_at: string;
  updated_at: string;
}

export interface VeraMatterPolicyUpdateWire {
  external_egress_mode: VeraMatterExternalEgressMode;
  execution_locations: VeraExecutionLocation[];
  allow_external_legal_sources: boolean;
  allow_word_bridge: boolean;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const PROJECT_KEYS = [
  "id",
  "name",
  "description",
  "cm_number",
  "practice",
  "status",
  "default_model_profile_id",
  "created_at",
  "updated_at",
  "archived_at",
  "document_count",
  "chat_count",
  "tabular_review_count",
  "workflow_count",
] as const;

const PROFILE_KEYS = [
  "project_id",
  "workspace_type",
  "client_name",
  "jurisdiction",
  "represented_role",
  "objective",
  "created_at",
  "updated_at",
] as const;

const CAPABILITY_KEYS = [
  "matter_profile",
  "assistant",
  "workflows",
  "tabular",
  "review",
  "drafts",
] as const;

const PROFILE_INPUT_LIMITS = {
  client_name: 500,
  jurisdiction: 240,
  represented_role: 240,
  objective: 16_384,
} as const;

const PROFILE_CREATE_KEYS = [
  "workspace_type",
  ...Object.keys(PROFILE_INPUT_LIMITS),
] as const;
const PROFILE_UPDATE_KEYS = [...PROFILE_CREATE_KEYS] as const;
const MATTER_CREATE_KEYS = [
  "name",
  "description",
  "cm_number",
  "practice",
  ...PROFILE_CREATE_KEYS,
] as const;
const MATTER_PROJECT_UPDATE_KEYS = [
  "name",
  "description",
  "cm_number",
  "practice",
] as const;
const MATTER_UPDATE_KEYS = ["project", "profile"] as const;
const POLICY_KEYS = [
  "project_id",
  "external_egress_mode",
  "execution_locations",
  "allow_external_legal_sources",
  "allow_word_bridge",
  "created_at",
  "updated_at",
] as const;
const POLICY_UPDATE_KEYS = [
  "external_egress_mode",
  "execution_locations",
  "allow_external_legal_sources",
  "allow_word_bridge",
] as const;

function invalidWire(label: string): never {
  throw new VeraApiError({
    status: 502,
    code: "INVALID_RESPONSE",
    message: `The Vera ${label} is invalid.`,
  });
}

function invalidInput(label: string): never {
  throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidWire(label);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidWire(label);
  }
}

function exactInputKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalidInput(label);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) invalidInput(label);
  return input;
}

function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return -1;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return -1;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return -1;
    }
    length += 1;
  }
  return length;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") return invalidWire(label);
  const length = codePointLength(value);
  if (value.trim().length === 0 || length < 1 || length > maximum) {
    return invalidWire(label);
  }
  return value;
}

function nullableText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string | null {
  if (value === null) return null;
  if (allowEmpty && typeof value === "string") {
    const length = codePointLength(value);
    if (length >= 0 && length <= maximum) return value;
  }
  return text(value, label, maximum);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalidWire(label);
  return value;
}

function safeId(value: string, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalidInput(label);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidWire(label);
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64) return invalidWire(label);
  if (Number.isNaN(new Date(value).valueOf())) return invalidWire(label);
  return value;
}

function canonicalUtc(value: unknown, label: string): string {
  const parsed = timestamp(value, label);
  if (!CANONICAL_UTC.test(parsed) || new Date(parsed).toISOString() !== parsed) {
    return invalidWire(label);
  }
  return parsed;
}

function parseMatterProject(value: unknown): VeraMatterProjectWire {
  const wire = record(value, "Matter Project response");
  exactKeys(wire, PROJECT_KEYS, "Matter Project response");
  uuid(wire.id, "Matter Project id");
  text(wire.name, "Matter Project name", 240);
  nullableText(wire.description, "Matter Project description", 2_000, true);
  nullableText(wire.cm_number, "Matter Project Matter number", 160, true);
  nullableText(wire.practice, "Matter Project practice area", 160, true);
  if (!["active", "archived", "deleted"].includes(String(wire.status))) {
    invalidWire("Matter Project status");
  }
  if (wire.default_model_profile_id !== null) {
    uuid(wire.default_model_profile_id, "Matter Project model profile id");
  }
  timestamp(wire.created_at, "Matter Project created timestamp");
  timestamp(wire.updated_at, "Matter Project updated timestamp");
  if (wire.archived_at !== null) {
    timestamp(wire.archived_at, "Matter Project archived timestamp");
  }
  nonNegativeInteger(wire.document_count, "Matter Project document count");
  nonNegativeInteger(wire.chat_count, "Matter Project chat count");
  nonNegativeInteger(
    wire.tabular_review_count,
    "Matter Project Tabular review count",
  );
  nonNegativeInteger(wire.workflow_count, "Matter Project workflow count");
  return wire as unknown as VeraMatterProjectWire;
}

export function parseVeraMatterProfileWire(
  value: unknown,
): VeraMatterProfileWire {
  const wire = record(value, "Matter Profile response");
  exactKeys(wire, PROFILE_KEYS, "Matter Profile response");
  uuid(wire.project_id, "Matter Profile project id");
  if (
    wire.workspace_type !== null &&
    !VERA_WORKSPACE_TYPES.includes(wire.workspace_type as VeraWorkspaceType)
  ) {
    invalidWire("Matter Profile workspace type");
  }
  nullableText(wire.client_name, "Matter Profile client name", 500);
  nullableText(wire.jurisdiction, "Matter Profile jurisdiction", 240);
  nullableText(wire.represented_role, "Matter Profile represented role", 240);
  nullableText(wire.objective, "Matter Profile objective", 16_384);
  const createdAt = canonicalUtc(
    wire.created_at,
    "Matter Profile created timestamp",
  );
  const updatedAt = canonicalUtc(
    wire.updated_at,
    "Matter Profile updated timestamp",
  );
  if (updatedAt < createdAt) invalidWire("Matter Profile timestamp ordering");
  return wire as unknown as VeraMatterProfileWire;
}

function parseCapabilities(value: unknown): VeraMatterCapabilitiesWire {
  const wire = record(value, "Matter capabilities response");
  exactKeys(wire, CAPABILITY_KEYS, "Matter capabilities response");
  if (
    !["create", "classify", "edit", "unavailable"].includes(
      String(wire.matter_profile),
    )
  ) {
    invalidWire("Matter Profile capability");
  }
  const inferenceCapabilities = [
    "available",
    "require_approval",
    "policy_gate_closed",
    "unavailable",
  ];
  if (!inferenceCapabilities.includes(String(wire.assistant)))
    invalidWire("Matter Assistant capability");
  if (
    ![...inferenceCapabilities, "non_inference_only"].includes(
      String(wire.workflows),
    )
  )
    invalidWire("Matter Workflow capability");
  if (!inferenceCapabilities.includes(String(wire.tabular)))
    invalidWire("Matter Tabular capability");
  if (!["available", "unavailable"].includes(String(wire.review)))
    invalidWire("Matter Review capability");
  if (
    !["document_scoped", "available", "unavailable"].includes(
      String(wire.drafts),
    )
  )
    invalidWire("Matter Draft capability");
  return wire as unknown as VeraMatterCapabilitiesWire;
}

function expectedPresentation(
  profile: VeraMatterProfileWire | null,
  projectStatus: VeraMatterProjectWire["status"],
): Pick<VeraMatterWire, "profile_state" | "capabilities"> {
  const profileState: VeraMatterProfileState =
    profile === null
      ? "absent"
      : profile.workspace_type === null
        ? "classification_required"
        : "ready";
  if (projectStatus !== "active") {
    return {
      profile_state: profileState,
      capabilities: {
        matter_profile: "unavailable",
        assistant: "unavailable",
        workflows: "unavailable",
        tabular: "unavailable",
        review: "unavailable",
        drafts: "unavailable",
      },
    };
  }
  if (profile === null) {
    return {
      profile_state: "absent",
      capabilities: {
        matter_profile: "create",
        assistant: "unavailable",
        workflows: "non_inference_only",
        tabular: "unavailable",
        review: "unavailable",
        drafts: "document_scoped",
      },
    };
  }
  return {
    profile_state:
      profile.workspace_type === null ? "classification_required" : "ready",
    capabilities: {
      matter_profile: profile.workspace_type === null ? "classify" : "edit",
      assistant: "unavailable",
      workflows: "non_inference_only",
      tabular: "unavailable",
      review: "unavailable",
      drafts: "document_scoped",
    },
  };
}

export function parseVeraMatterWire(value: unknown): VeraMatterWire {
  const wire = record(value, "Matter response");
  exactKeys(
    wire,
    ["project", "matter_profile", "profile_state", "capabilities"],
    "Matter response",
  );
  const project = parseMatterProject(wire.project);
  const matterProfile =
    wire.matter_profile === null
      ? null
      : parseVeraMatterProfileWire(wire.matter_profile);
  if (matterProfile !== null && matterProfile.project_id !== project.id) {
    invalidWire("Matter ownership response");
  }
  if (!VERA_MATTER_PROFILE_STATES.includes(wire.profile_state as VeraMatterProfileState)) {
    invalidWire("Matter Profile state");
  }
  const capabilities = parseCapabilities(wire.capabilities);
  const expected = expectedPresentation(matterProfile, project.status);
  if (
    wire.profile_state !== expected.profile_state ||
    capabilities.matter_profile !== expected.capabilities.matter_profile ||
    (project.status !== "active" &&
      (capabilities.assistant !== "unavailable" ||
        capabilities.workflows !== "unavailable" ||
        capabilities.tabular !== "unavailable" ||
        capabilities.review !== "unavailable" ||
        capabilities.drafts !== "unavailable"))
  ) {
    invalidWire("Matter capability state");
  }
  return {
    project,
    matter_profile: matterProfile,
    profile_state: wire.profile_state as VeraMatterProfileState,
    capabilities,
  };
}

export function parseVeraMatterPolicyWire(value: unknown): VeraMatterPolicyWire {
  const wire = record(value, "Matter Policy response");
  exactKeys(wire, POLICY_KEYS, "Matter Policy response");
  uuid(wire.project_id, "Matter Policy project id");
  if (
    !["disabled", "approval", "allowed_by_policy"].includes(
      String(wire.external_egress_mode),
    )
  ) {
    invalidWire("Matter Policy external egress mode");
  }
  if (
    !Array.isArray(wire.execution_locations) ||
    wire.execution_locations.length > VERA_EXECUTION_LOCATIONS.length ||
    wire.execution_locations.some(
      (location) =>
        !VERA_EXECUTION_LOCATIONS.includes(location as VeraExecutionLocation),
    ) ||
    new Set(wire.execution_locations).size !== wire.execution_locations.length
  ) {
    invalidWire("Matter Policy execution locations");
  }
  if (
    typeof wire.allow_external_legal_sources !== "boolean" ||
    typeof wire.allow_word_bridge !== "boolean"
  ) {
    invalidWire("Matter Policy boolean declarations");
  }
  const createdAt = canonicalUtc(wire.created_at, "Matter Policy created timestamp");
  const updatedAt = canonicalUtc(wire.updated_at, "Matter Policy updated timestamp");
  if (updatedAt < createdAt) invalidWire("Matter Policy timestamp ordering");
  return wire as unknown as VeraMatterPolicyWire;
}

export function parseVeraMatterPageWire(value: unknown): VeraMatterPageWire {
  const wire = record(value, "Matter page response");
  exactKeys(wire, ["items", "next_cursor"], "Matter page response");
  if (!Array.isArray(wire.items) || wire.items.length > 100) {
    invalidWire("Matter page items");
  }
  if (
    wire.next_cursor !== null &&
    (typeof wire.next_cursor !== "string" ||
      wire.next_cursor.length < 1 ||
      wire.next_cursor.length > 512 ||
      !BASE64URL.test(wire.next_cursor))
  ) {
    invalidWire("Matter page cursor");
  }
  return {
    items: wire.items.map(parseVeraMatterWire),
    next_cursor: wire.next_cursor as string | null,
  };
}

function inputText(
  value: unknown,
  label: string,
  maximum: number,
  nullable: boolean,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value !== value.trim()) invalidInput(label);
  const length = codePointLength(value as string);
  if (length < 1 || length > maximum) invalidInput(label);
  return value as string;
}

function validateWorkspaceType(value: unknown, required: boolean) {
  if (value === undefined && !required) return;
  if (!VERA_WORKSPACE_TYPES.includes(value as VeraWorkspaceType)) {
    invalidInput("Matter Profile workspace type");
  }
}

function validateProfileInput(
  input: unknown,
  mode: "create" | "update",
  wholeMatter = false,
) {
  const wire = exactInputKeys(
    input,
    wholeMatter
      ? MATTER_CREATE_KEYS
      : mode === "create"
        ? PROFILE_CREATE_KEYS
        : PROFILE_UPDATE_KEYS,
    "Matter Profile request",
  );
  validateWorkspaceType(wire.workspace_type, mode === "create");
  for (const [key, maximum] of Object.entries(PROFILE_INPUT_LIMITS)) {
    inputText(wire[key], `Matter Profile ${key}`, maximum, true);
  }
  if (
    mode === "update" &&
    (Object.keys(wire).length === 0 ||
      Object.values(wire).every((value) => value === undefined))
  ) {
    invalidInput("Matter Profile update");
  }
  return wire;
}

function validateMatterCreateInput(input: unknown) {
  const wire = validateProfileInput(input, "create", true);
  if (wire.name === undefined) invalidInput("Matter name");
  inputText(wire.name, "Matter name", 240, false);
  inputText(wire.description, "Matter description", 2_000, true);
  inputText(wire.cm_number, "Matter number", 160, true);
  inputText(wire.practice, "Matter practice area", 160, true);
}

function validateMatterUpdateInput(input: unknown) {
  const wire = exactInputKeys(input, MATTER_UPDATE_KEYS, "Matter update request");
  if (wire.project === undefined && wire.profile === undefined) {
    invalidInput("Matter update request");
  }
  if (wire.project !== undefined) {
    const project = exactInputKeys(
      wire.project,
      MATTER_PROJECT_UPDATE_KEYS,
      "Matter Project update request",
    );
    if (
      Object.keys(project).length === 0 ||
      Object.values(project).some((value) => value === undefined)
    ) {
      invalidInput("Matter Project update request");
    }
    inputText(project.name, "Matter Project name", 240, false);
    inputText(project.description, "Matter Project description", 2_000, true);
    inputText(project.cm_number, "Matter Project Matter number", 160, true);
    inputText(project.practice, "Matter Project practice area", 160, true);
  }
  if (wire.profile !== undefined) validateProfileInput(wire.profile, "update");
}

function validateMatterPolicyUpdateInput(input: unknown) {
  const wire = exactInputKeys(
    input,
    POLICY_UPDATE_KEYS,
    "Matter Policy update request",
  );
  if (
    Object.keys(wire).length !== POLICY_UPDATE_KEYS.length ||
    POLICY_UPDATE_KEYS.some((key) => !Object.hasOwn(wire, key))
  ) {
    invalidInput("Matter Policy update request");
  }
  if (
    !["disabled", "approval", "allowed_by_policy"].includes(
      String(wire.external_egress_mode),
    )
  ) {
    invalidInput("Matter Policy external egress mode");
  }
  if (
    !Array.isArray(wire.execution_locations) ||
    wire.execution_locations.length > VERA_EXECUTION_LOCATIONS.length ||
    wire.execution_locations.some(
      (location) =>
        !VERA_EXECUTION_LOCATIONS.includes(location as VeraExecutionLocation),
    ) ||
    new Set(wire.execution_locations).size !== wire.execution_locations.length
  ) {
    invalidInput("Matter Policy execution locations");
  }
  if (
    typeof wire.allow_external_legal_sources !== "boolean" ||
    typeof wire.allow_word_bridge !== "boolean"
  ) {
    invalidInput("Matter Policy boolean declarations");
  }
}

function matterQuery(query: unknown): VeraQuery {
  const wire = exactInputKeys(
    query,
    ["status", "profile_state", "cursor", "limit"],
    "Matter list query",
  );
  if (
    wire.profile_state !== undefined &&
    !["profiled", "ready", "classification_required", "absent", "all"].includes(
      String(wire.profile_state),
    )
  ) {
    invalidInput("Matter list profile state");
  }
  if (
    wire.status !== undefined &&
    wire.status !== "active" &&
    wire.status !== "archived"
  ) {
    invalidInput("Matter list status");
  }
  if (
    wire.cursor !== undefined &&
    (typeof wire.cursor !== "string" ||
      wire.cursor.length < 1 ||
      wire.cursor.length > 512 ||
      !BASE64URL.test(wire.cursor))
  ) {
    invalidInput("Matter list cursor");
  }
  if (
    wire.limit !== undefined &&
    (!Number.isInteger(wire.limit) ||
      Number(wire.limit) < 1 ||
      Number(wire.limit) > 100)
  ) {
    invalidInput("Matter list limit");
  }
  return wire as VeraQuery;
}

export async function listVeraMatters(
  query: VeraMatterListQuery = {},
  signal?: AbortSignal,
): Promise<VeraMatterPageWire> {
  return parseVeraMatterPageWire(
    await veraApiRequest<unknown>("/matters", {
      query: matterQuery(query),
      signal,
    }),
  );
}

export async function getVeraMatter(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraMatterWire> {
  return parseVeraMatterWire(
    await veraApiRequest<unknown>(
      `/matters/${safeId(projectId, "Matter project id")}`,
      { signal },
    ),
  );
}

export async function updateVeraMatter(
  projectId: string,
  input: VeraMatterUpdateWire,
  signal?: AbortSignal,
): Promise<VeraMatterWire> {
  validateMatterUpdateInput(input);
  return parseVeraMatterWire(
    await veraApiRequest<unknown>(
      `/matters/${safeId(projectId, "Matter project id")}`,
      { method: "PATCH", json: input, signal },
    ),
  );
}

function matterPolicyPath(projectId: string): string {
  return `/matters/${safeId(projectId, "Matter project id")}/policy`;
}

export async function getVeraMatterPolicy(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraMatterPolicyWire> {
  return parseVeraMatterPolicyWire(
    await veraApiRequest<unknown>(matterPolicyPath(projectId), { signal }),
  );
}

export async function updateVeraMatterPolicy(
  projectId: string,
  input: VeraMatterPolicyUpdateWire,
  signal?: AbortSignal,
): Promise<VeraMatterPolicyWire> {
  validateMatterPolicyUpdateInput(input);
  return parseVeraMatterPolicyWire(
    await veraApiRequest<unknown>(matterPolicyPath(projectId), {
      method: "PATCH",
      json: input,
      signal,
    }),
  );
}

export async function createVeraMatter(
  input: VeraMatterCreateWire,
  signal?: AbortSignal,
): Promise<VeraMatterWire> {
  validateMatterCreateInput(input);
  return parseVeraMatterWire(
    await veraApiRequest<unknown>("/matters", {
      method: "POST",
      json: input,
      signal,
    }),
  );
}

function matterProfilePath(projectId: string): string {
  return `/projects/${safeId(projectId, "Matter project id")}/matter-profile`;
}

export async function getVeraMatterProfile(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraMatterWire> {
  return parseVeraMatterWire(
    await veraApiRequest<unknown>(matterProfilePath(projectId), { signal }),
  );
}

export async function createVeraMatterProfile(
  projectId: string,
  input: VeraMatterProfileCreateWire,
  signal?: AbortSignal,
): Promise<VeraMatterWire> {
  validateProfileInput(input, "create");
  return parseVeraMatterWire(
    await veraApiRequest<unknown>(matterProfilePath(projectId), {
      method: "POST",
      json: input,
      signal,
    }),
  );
}

export async function updateVeraMatterProfile(
  projectId: string,
  input: VeraMatterProfileUpdateWire,
  signal?: AbortSignal,
): Promise<VeraMatterWire> {
  validateProfileInput(input, "update");
  return parseVeraMatterWire(
    await veraApiRequest<unknown>(matterProfilePath(projectId), {
      method: "PATCH",
      json: input,
      signal,
    }),
  );
}
