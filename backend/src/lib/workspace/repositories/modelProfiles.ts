import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import type { ModelProfile } from "../types";
type Row = Record<string, unknown>;
type Caps = ModelProfile["capabilities"];
function capabilities(raw: unknown): Caps {
  try {
    const v = JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
    const keys = ["streaming", "toolCalling", "structuredOutput", "vision"];
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).length !== keys.length ||
      keys.some((key) => typeof v[key] !== "boolean")
    )
      throw new Error();
    return {
      streaming: v.streaming as boolean,
      toolCalling: v.toolCalling as boolean,
      structuredOutput: v.structuredOutput as boolean,
      vision: v.vision as boolean,
    };
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Model capabilities are corrupt.",
    );
  }
}
function map(r: Row): ModelProfile {
  return {
    id: String(r.id),
    name: String(r.name),
    provider: r.provider as ModelProfile["provider"],
    model: String(r.model),
    baseUrl: r.base_url == null ? null : String(r.base_url),
    credentialStatus: r.credential_status as ModelProfile["credentialStatus"],
    contextWindowTokens:
      r.context_window_tokens == null ? null : Number(r.context_window_tokens),
    maxOutputTokens:
      r.max_output_tokens == null ? null : Number(r.max_output_tokens),
    enabled: Number(r.enabled) === 1,
    capabilities: capabilities(r.capabilities_json),
    isDefault: Number(r.is_default) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
export class ModelProfilesRepository {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}
  private tx<T>(fn: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.database.exec("COMMIT");
      return v;
    } catch (e) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
  list() {
    return this.database
      .prepare(
        "SELECT * FROM model_profiles ORDER BY is_default DESC, updated_at DESC,id DESC",
      )
      .all()
      .map(map);
  }
  get(id: string) {
    const r = this.database
      .prepare("SELECT * FROM model_profiles WHERE id=?")
      .get(id);
    return r ? map(r) : null;
  }
  require(id: string) {
    const v = this.get(id);
    if (!v)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Model profile not found.");
    return v;
  }
  create(input: {
    id: string;
    name: string;
    provider: ModelProfile["provider"];
    model: string;
    baseUrl: string | null;
    contextWindowTokens: number | null;
    maxOutputTokens: number | null;
    enabled: boolean;
    isDefault: boolean;
    capabilities: Caps;
    now: string;
  }) {
    return this.tx(() => {
      if (input.isDefault && !input.enabled)
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Default model profile must be enabled.",
        );
      this.database
        .prepare(
          "INSERT INTO model_profiles (id,name,provider,model,base_url,context_window_tokens,max_output_tokens,enabled,is_default,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)",
        )
        .run(
          input.id,
          input.name,
          input.provider,
          input.model,
          input.baseUrl,
          input.contextWindowTokens,
          input.maxOutputTokens,
          input.enabled ? 1 : 0,
          JSON.stringify(input.capabilities),
          input.now,
          input.now,
        );
      if (input.isDefault) this.setDefaultInTransaction(input.id, input.now);
      return this.require(input.id);
    });
  }
  update(
    id: string,
    input: Partial<{
      name: string;
      provider: ModelProfile["provider"];
      model: string;
      baseUrl: string | null;
      contextWindowTokens: number | null;
      maxOutputTokens: number | null;
      enabled: boolean;
      isDefault: boolean;
      capabilities: Caps;
    }> & { now: string },
  ) {
    return this.tx(() => {
      const p = this.require(id);
      const enabled = input.enabled ?? p.enabled;
      if (input.isDefault === true && !enabled)
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Default model profile must be enabled.",
        );
      this.database
        .prepare(
          "UPDATE model_profiles SET name=?,provider=?,model=?,base_url=?,context_window_tokens=?,max_output_tokens=?,enabled=?,capabilities_json=?,updated_at=? WHERE id=?",
        )
        .run(
          input.name ?? p.name,
          input.provider ?? p.provider,
          input.model ?? p.model,
          input.baseUrl === undefined ? p.baseUrl : input.baseUrl,
          input.contextWindowTokens === undefined
            ? p.contextWindowTokens
            : input.contextWindowTokens,
          input.maxOutputTokens === undefined
            ? p.maxOutputTokens
            : input.maxOutputTokens,
          enabled ? 1 : 0,
          JSON.stringify(input.capabilities ?? p.capabilities),
          input.now,
          id,
        );
      if (input.isDefault === true) this.setDefaultInTransaction(id, input.now);
      if (
        (input.isDefault === false || input.enabled === false) &&
        p.isDefault
      ) {
        this.database
          .prepare("UPDATE model_profiles SET is_default=0 WHERE id=?")
          .run(id);
        this.database
          .prepare(
            "UPDATE workspace_settings SET default_model_profile_id=NULL,updated_at=? WHERE id='workspace'",
          )
          .run(input.now);
      }
      return this.require(id);
    });
  }
  setDefault(id: string, now: string) {
    return this.tx(() => {
      this.requireEnabled(id);
      this.setDefaultInTransaction(id, now);
      return this.require(id);
    });
  }
  private setDefaultInTransaction(id: string, now: string) {
    this.database
      .prepare("UPDATE model_profiles SET is_default=0 WHERE is_default=1")
      .run();
    this.database
      .prepare("UPDATE model_profiles SET is_default=1,updated_at=? WHERE id=?")
      .run(now, id);
    this.database
      .prepare(
        "UPDATE workspace_settings SET default_model_profile_id=?,updated_at=? WHERE id='workspace'",
      )
      .run(id, now);
  }
  enable(id: string, enabled: boolean, now: string) {
    return this.update(id, { enabled, now });
  }
  delete(id: string, now: string) {
    return this.tx(() => {
      this.require(id);
      this.database
        .prepare(
          "UPDATE workspace_settings SET default_model_profile_id=NULL,updated_at=? WHERE default_model_profile_id=?",
        )
        .run(now, id);
      this.database
        .prepare(
          "UPDATE projects SET default_model_profile_id=NULL,updated_at=? WHERE default_model_profile_id=?",
        )
        .run(now, id);
      this.database.prepare("DELETE FROM model_profiles WHERE id=?").run(id);
    });
  }
  /** Internal Keychain bridge only. No public service method exposes this locator. */ setCredentialReferenceInternal(
    id: string,
    locator: string | null,
    status: ModelProfile["credentialStatus"],
    now: string,
  ) {
    if (locator !== null && locator !== `keychain://vera/model-profile/${id}`)
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Credential locator is invalid.",
      );
    this.database
      .prepare(
        "UPDATE model_profiles SET credential_ref=?,credential_status=?,updated_at=? WHERE id=?",
      )
      .run(locator, status, now, id);
    this.require(id);
  }
  requireEnabled(id: string) {
    const p = this.require(id);
    if (!p.enabled)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile is disabled.",
      );
    return p;
  }
}
