import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@akeru/shared/model";
import { CodexSettings, ProviderInstanceId } from "@akeru/contracts";
import * as ServerConfig from "../../config.ts";
import * as TextGeneration from "../TextGeneration.ts";
import { layerWithSettings } from "../CodexTextGeneration.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const CodexTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeCodexBinary(
  dir: string,
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireServiceTier?: string;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    requireArg?: string;
    forbidArg?: string;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'original_args="$*"',
        'output_path=""',
        'seen_image="0"',
        'seen_service_tier=""',
        'seen_reasoning_effort=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    case "$1" in',
        "      service_tier=*)",
        '        seen_service_tier="$1"',
        "        ;;",
        "    esac",
        '    case "$1" in',
        "      model_reasoning_effort=*)",
        '        seen_reasoning_effort="$1"',
        "        ;;",
        "    esac",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        ...(input.requireArg !== undefined
          ? [
              `case " $original_args " in *" ${input.requireArg} "*) ;; *)`,
              `  printf "%s\\n" "missing arg: ${input.requireArg}" >&2`,
              `  exit 8`,
              "esac",
            ]
          : []),
        ...(input.forbidArg !== undefined
          ? [
              `case " $original_args " in *" ${input.forbidArg} "*)`,
              `  printf "%s\\n" "forbidden arg: ${input.forbidArg}" >&2`,
              `  exit 9`,
              "esac",
            ]
          : []),
        ...(input.requireImage
          ? [
              'if [ "$seen_image" != "1" ]; then',
              '  printf "%s\\n" "missing --image input" >&2',
              `  exit 2`,
              "fi",
            ]
          : []),
        ...(input.requireServiceTier
          ? [
              `if [ "$seen_service_tier" != "service_tier=\\"${input.requireServiceTier}\\"" ]; then`,
              '  printf "%s\\n" "unexpected service tier config: $seen_service_tier" >&2',
              `  exit 5`,
              "fi",
            ]
          : []),
        ...(input.requireReasoningEffort !== undefined
          ? [
              `if [ "$seen_reasoning_effort" != "model_reasoning_effort=\\"${input.requireReasoningEffort}\\"" ]; then`,
              '  printf "%s\\n" "unexpected reasoning effort config: $seen_reasoning_effort" >&2',
              `  exit 6`,
              "fi",
            ]
          : []),
        ...(input.forbidReasoningEffort
          ? [
              'if [ -n "$seen_reasoning_effort" ]; then',
              '  printf "%s\\n" "reasoning effort config should be omitted: $seen_reasoning_effort" >&2',
              `  exit 7`,
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              `  exit 3`,
              "fi",
            ]
          : []),
        ...(input.stdinMustNotContain !== undefined
          ? [
              `if printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustNotContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin contained forbidden content" >&2',
              `  exit 4`,
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [
              `printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`,
            ]
          : []),
        'if [ -n "$output_path" ]; then',
        "  cat > \"$output_path\" <<'__T3CODE_FAKE_CODEX_OUTPUT__'",
        input.output,
        "__T3CODE_FAKE_CODEX_OUTPUT__",
        "fi",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);

    return codexPath;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireServiceTier?: string;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    requireArg?: string;
    forbidArg?: string;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath, launchArgs: input.launchArgs });

    return yield* Effect.flatMap(TextGeneration.TextGeneration, effectFn).pipe(
      Effect.provide(layerWithSettings(config, input.environment)),
    );
  }).pipe(Effect.scoped);
}

export {
  decodeCodexSettings,
  DEFAULT_TEST_MODEL_SELECTION,
  CodexTextGenerationTestLayer,
  makeFakeCodexBinary,
  withFakeCodexEnv,
};
