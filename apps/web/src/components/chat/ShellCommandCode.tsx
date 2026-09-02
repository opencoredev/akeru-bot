import { getFiletypeFromFileName } from "@pierre/diffs";
import { memo, Suspense, use, useMemo, type CSSProperties } from "react";

import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

/** Matches the language the diff viewer resolves for shell files, so both use one theme set. */
const SHELL_LANGUAGE = getFiletypeFromFileName("command.sh");

interface CodeToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

function tokenStyle(token: CodeToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  };
}

function PlainCommand({ command }: { readonly command: string }) {
  return <>{command}</>;
}

function HighlightedCommand(props: { readonly command: string; readonly theme: "light" | "dark" }) {
  const highlighter = use(getSyntaxHighlighterPromise(SHELL_LANGUAGE));
  const lines = useMemo(() => {
    try {
      return highlighter.codeToTokens(props.command, {
        lang: SHELL_LANGUAGE,
        theme: resolveDiffThemeName(props.theme),
      }).tokens;
    } catch {
      return undefined;
    }
  }, [highlighter, props.command, props.theme]);

  if (!lines) return <PlainCommand command={props.command} />;

  return lines.map((tokens, lineIndex) => (
    <span key={`line-${String(lineIndex)}`}>
      {lineIndex > 0 ? "\n" : null}
      {tokens.map((token: CodeToken, tokenIndex: number) => (
        <span key={`token-${String(tokenIndex)}`} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </span>
  ));
}

/**
 * Shell command text with syntax colors. Falls back to the same plain text while the
 * highlighter loads and whenever it fails, so the row never blanks or shifts.
 */
export const ShellCommandCode = memo(function ShellCommandCode(props: {
  readonly command: string;
  readonly theme: "light" | "dark";
}) {
  const fallback = <PlainCommand command={props.command} />;

  return (
    <RenderErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <HighlightedCommand command={props.command} theme={props.theme} />
      </Suspense>
    </RenderErrorBoundary>
  );
});
