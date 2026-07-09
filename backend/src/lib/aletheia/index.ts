import { LocalAletheiaRepository } from "./localRepository";
import type { AletheiaRepository } from "./repository";
import { SupabaseAletheiaRepository } from "./supabaseRepository";

export function createAletheiaRepository(): AletheiaRepository {
  const storageDriver =
    process.env.ALETHEIA_STORAGE_DRIVER ?? process.env.ALET_HEIA_STORAGE_MODE;
  if (storageDriver === "local") {
    return new LocalAletheiaRepository();
  }
  return new SupabaseAletheiaRepository();
}

export type {
  AddReviewInput,
  AletheiaRepository,
  AletheiaUserContext,
  AppendAuditEventInput,
  CreateAgentRunInput,
  CreateMatterInput,
  CreateWorkProductInput,
} from "./repository";
