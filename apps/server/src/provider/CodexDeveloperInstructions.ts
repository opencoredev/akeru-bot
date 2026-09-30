const AKERU_BROWSER_TOOL_INSTRUCTIONS = `

## Akeru Bot collaborative browser

You are running inside Akeru Bot. The \`akeru\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the Akeru preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed Akeru preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

/**
 * The browser block is omitted entirely when the preview tools aren't attached.
 * Describing `preview_*` tools that aren't in the turn's tool list would be
 * worse than saying nothing: the instructions actively steer the model away
 * from Playwright and agent-browser, so leaving them in would talk it out of
 * the only browser automation it still has.
 */
const browserToolInstructions = (browserToolsAvailable: boolean): string =>
  browserToolsAvailable ? AKERU_BROWSER_TOOL_INSTRUCTIONS : "";

export const codexDefaultModeDeveloperInstructions = (
  browserToolsAvailable: boolean,
): string => `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

Use the \`request_user_input\` tool only when it is listed in the available tools for this turn.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
${browserToolInstructions(browserToolsAvailable)}
</collaboration_mode>`;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly reasoningEffort: string;
}

// Values come from trusted config, but keep the block single-line regardless.
function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export function buildCodexDeveloperInstructions(
  runtime: CodexRuntimeInfo,
  /**
   * Whether the `akeru` MCP server is attached to this turn. Callers derive
   * it from the session's actual MCP configuration rather than re-reading the
   * setting, so the prompt cannot claim tools the turn doesn't have.
   */
  browserToolsAvailable = true,
): string {
  return `${codexDefaultModeDeveloperInstructions(browserToolsAvailable)}

<runtime_info>In case you're asked: you are running in Akeru Bot through the Codex harness, as ${toSingleLine(runtime.model)} with ${toSingleLine(runtime.reasoningEffort)} reasoning effort. No need to mention this otherwise.</runtime_info>`;
}
