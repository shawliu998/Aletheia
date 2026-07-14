import { randomUUID } from "node:crypto";
import {
  CreateModelProfileRequestSchema,
  UpdateModelProfileRequestSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import { ModelProfilesRepository } from "../repositories/modelProfiles";
export class ModelProfilesService {
  constructor(
    private readonly repository: ModelProfilesRepository,
    private readonly options: { allowLocalDevelopmentBaseUrl?: boolean } = {},
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now() {
    return this.clock().toISOString();
  }
  private gate(url: string | null | undefined) {
    if (url?.startsWith("http:") && !this.options.allowLocalDevelopmentBaseUrl)
      throw new WorkspaceApiError(
        403,
        "FORBIDDEN",
        "Loopback HTTP model endpoints require explicit local-development enablement.",
      );
  }
  list() {
    return this.repository.list();
  }
  get(id: string) {
    return this.repository.require(id);
  }
  create(value: unknown) {
    const v = CreateModelProfileRequestSchema.parse(value);
    this.gate(v.baseUrl);
    return this.repository.create({
      id: randomUUID(),
      name: v.name,
      provider: v.provider,
      model: v.model,
      baseUrl: v.baseUrl ?? null,
      contextWindowTokens: v.contextWindowTokens ?? null,
      maxOutputTokens: v.maxOutputTokens ?? null,
      enabled: v.enabled ?? true,
      isDefault: v.isDefault ?? false,
      capabilities: v.capabilities ?? {
        streaming: false,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
      },
      now: this.now(),
    });
  }
  update(id: string, value: unknown) {
    const v = UpdateModelProfileRequestSchema.parse(value);
    this.gate(v.baseUrl);
    return this.repository.update(id, { ...v, now: this.now() });
  }
  enable(id: string) {
    return this.repository.enable(id, true, this.now());
  }
  disable(id: string) {
    return this.repository.enable(id, false, this.now());
  }
  setDefault(id: string) {
    return this.repository.setDefault(id, this.now());
  }
  delete(id: string) {
    this.repository.delete(id, this.now());
  }
}
