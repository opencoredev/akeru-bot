import * as Schema from "effect/Schema";

export class McpServerAuthenticationClientError extends Schema.TaggedErrorClass<McpServerAuthenticationClientError>()(
  "McpServerAuthenticationClientError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
