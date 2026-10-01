/**
 * Forgiving parser for user-pasted OAuth authorization input.
 *
 * Ported from Mastra Code (mastra-ai/mastra,
 * `mastracode/sdk/src/auth/authorization-input.ts`), Apache-2.0.
 *
 * Accepts, in order of preference:
 *   - a full redirect URL (`https://.../callback?code=...&state=...`)
 *   - the `code#state` form shown on Anthropic's hosted callback page
 *   - a raw query string (`code=...&state=...`)
 *   - a bare authorization code
 */
export function parseAuthorizationInput(input: string): {
  code?: string | undefined;
  state?: string | undefined;
} {
  const value = input.trim();

  if (!value) return {};

  try {
    const url = new URL(value);

    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);

    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);

    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}
