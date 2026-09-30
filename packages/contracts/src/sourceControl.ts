import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Hosting provider detected from a git remote URL. Repository identities
 * record it so projects on different machines can be matched; Akeru has no
 * hosting integrations.
 */
export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;
