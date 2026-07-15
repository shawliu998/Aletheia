/**
 * Vera-named facade over the strict local legal-source contract.
 *
 * Keep parsing, authentication, and secret handling canonical in
 * `aletheiaApi`; the Mike Settings UI imports only these Vera aliases.
 */
export {
  AletheiaApiError as VeraLegalSourceApiError,
  listAletheiaLegalSourceProviders as listVeraLegalSourceProviders,
  removeAletheiaLegalSourceSecret as removeVeraLegalSourceSecret,
  saveAletheiaLegalSourceSecret as saveVeraLegalSourceSecret,
} from "@/app/lib/aletheiaApi";

export type {
  AletheiaLegalSourceConnectionStatus as VeraLegalSourceConnectionStatus,
  AletheiaLegalSourceDataUsePolicy as VeraLegalSourceDataUsePolicy,
  AletheiaLegalSourceProvider as VeraLegalSourceProvider,
  AletheiaLegalSourceProviderId as VeraLegalSourceProviderId,
  AletheiaLegalSourceUnavailableReason as VeraLegalSourceUnavailableReason,
} from "@/app/lib/aletheiaApi";
