# Observability

> For maintainers. Using Akeru Bot? See [docs/user](../user/).

Akeru Bot has one server-side observability model:

- pretty logs go to stdout for humans
- completed spans go to a local NDJSON trace file
- traces and metrics can also be exported over OTLP to a real backend like Grafana LGTM

The local trace file is the persisted source of truth for normal local launches. Those launches do not
write a separate server log file, but SSH-managed launches also persist the remote process's
stdout/stderr at `~/.t3/ssh-launch/<state>/server.log`.

## Where To Find Things

### Logs

Logs are human-facing:

- destination: stdout
- format: `Logger.consolePretty()`
- normal local persistence: none
- SSH-managed launch persistence: `~/.t3/ssh-launch/<state>/server.log`

If you want a log message to show up in the trace file, emit it inside an active span with `Effect.log...`. `Logger.tracerLogger` will attach it as a span event.

### Traces

Completed spans are written as NDJSON records to `serverTracePath`. The default depends on how the
server starts: production and explicitly configured homes use
`<home>/userdata/logs/server.trace.ndjson` (so `~/.akeru/userdata/...` by default, or
`/custom/path/userdata/...` with `--home-dir /custom/path`), a linked worktree dev run uses
`<worktree>/.akeru/userdata/logs/server.trace.ndjson`, and an implicit dev run outside a linked
worktree uses `~/.akeru/dev/logs/server.trace.ndjson`.

Important fields common to both record types:

- `type`: `effect-span` or `otlp-span`
- `name`: span name
- `traceId`, `spanId`, `parentSpanId`: correlation
- `durationMs`: elapsed time
- `attributes`: structured context
- `events`: embedded logs and custom events

`effect-span` records also contain `exit` with `Success`, `Failure`, or `Interrupted`. `otlp-span`
records instead carry OTLP resource, scope, and optional status fields.

The `TraceRecord`, `EffectTraceRecord`, and `OtlpTraceRecord` schemas live in
`packages/shared/src/observability.ts`.

### Metrics

Metrics are not written to a local file.

- local persistence: none
- remote export: OTLP only, when configured
- current definitions: `apps/server/src/observability/Metrics.ts`

If OTLP is not configured, metrics still exist in-process, but you will not have a local artifact to inspect.

### Related Artifacts

Provider event NDJSON files still exist for provider runtime streams. Those are separate from the main server trace file.

## Run The Server In Instrumented Mode

There are two useful modes:

- local-only: stdout + local `server.trace.ndjson`
- full local observability: stdout + local trace file + OTLP export to Grafana/Tempo/Prometheus

The local trace file is always on. OTLP export is opt-in.

### Option 1: Local Traces Only

You do not need any extra env vars. Just run the app normally and inspect `server.trace.ndjson`.

Examples:

```bash
npx akeru-bot
```

```bash
node --run dev
```

```bash
node --run dev:desktop
```

### Option 2: Run With A Local LGTM Stack

#### 1. Start Grafana LGTM

```bash
docker run --name lgtm \
  -p 3000:3000 \
  -p 4317:4317 \
  -p 4318:4318 \
  --rm -ti \
  grafana/otel-lgtm
```

Then open `http://localhost:3000`.

Default Grafana login:

- username: `admin`
- password: `admin`

#### 2. Export OTLP env vars

```bash
export AKERU_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export AKERU_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export AKERU_OTLP_SERVICE_NAME=akeru-local
```

Optional:

```bash
export AKERU_TRACE_MIN_LEVEL=Info
export AKERU_TRACE_TIMING_ENABLED=true
```

#### 3. Launch the app from that same shell

CLI:

```bash
npx akeru-bot
```

Monorepo web/server dev:

```bash
node --run dev
```

Monorepo desktop dev:

```bash
node --run dev:desktop
```

Packaged desktop app:

Launch the actual app executable from the same shell so the desktop app and embedded backend inherit `AKERU_OTLP_*`.

macOS app bundle example:

```bash
AKERU_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
AKERU_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
AKERU_OTLP_SERVICE_NAME=akeru-desktop \
"/Applications/Akeru Bot (Alpha).app/Contents/MacOS/Akeru Bot (Alpha)"
```

Direct binary example:

```bash
AKERU_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
AKERU_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
AKERU_OTLP_SERVICE_NAME=akeru-desktop \
./path/to/your/desktop-app-binary
```

Do not rely on launching from Finder, Spotlight, the dock, or the Start menu after setting shell env vars. Those launches usually will not pick them up.

#### 4. Fully restart after changing env

The backend reads observability config at process start. If you change OTLP env vars, stop the app completely and start it again.

## How To Use Traces And Metrics To Debug The Server

### Start With The Local Trace File

The trace file is the fastest way to inspect raw span data.

Resolve the path for the launch mode once. Production and explicitly configured homes store runtime
state under the base directory's `userdata` folder:

```bash
TRACE_FILE="${AKERU_HOME:-$HOME/.akeru}/userdata/logs/server.trace.ndjson"
```

A dev server started from a linked worktree defaults to that worktree's local home:

```bash
TRACE_FILE="$WORKTREE/.akeru/userdata/logs/server.trace.ndjson"
```

Only an implicit dev run outside a linked worktree uses the shared dev directory:

```bash
TRACE_FILE="$HOME/.akeru/dev/logs/server.trace.ndjson"
```

Tail the selected file:

```bash
tail -f "$TRACE_FILE"
```

Show failed spans:

```bash
jq -c 'select(.type == "effect-span" and .exit._tag != "Success") | {
  name,
  durationMs,
  exit,
  attributes
}' "$TRACE_FILE"
```

Show slow spans:

```bash
jq -c 'select(.durationMs > 1000) | {
  name,
  durationMs,
  traceId,
  spanId
}' "$TRACE_FILE"
```

Inspect embedded log events:

```bash
jq -c 'select(any(.events[]?; .attributes["effect.logLevel"] != null)) | {
  name,
  durationMs,
  events: [
    .events[]
    | select(.attributes["effect.logLevel"] != null)
    | {
        message: .name,
        level: .attributes["effect.logLevel"]
      }
  ]
}' "$TRACE_FILE"
```

Follow one trace:

```bash
jq -r 'select(.traceId == "TRACE_ID_HERE") | [
  .name,
  .spanId,
  (.parentSpanId // "-"),
  .durationMs
] | @tsv' "$TRACE_FILE"
```

Filter orchestration commands:

```bash
jq -c 'select(.attributes["orchestration.command_type"] != null) | {
  name,
  durationMs,
  commandType: .attributes["orchestration.command_type"],
  aggregateKind: .attributes["orchestration.aggregate_kind"]
}' "$TRACE_FILE"
```

Filter git activity:

```bash
jq -c 'select(.attributes["git.operation"] != null) | {
  name,
  durationMs,
  operation: .attributes["git.operation"],
  cwd: .attributes["git.cwd"],
  hookEvents: [
    .events[]
    | select(.name == "git.hook.started" or .name == "git.hook.finished")
  ]
}' "$TRACE_FILE"
```

### Use Tempo When You Need A Real Trace Viewer

Tempo is better than raw NDJSON when you want to:

- search across many traces
- inspect parent/child relationships visually
- compare many slow traces
- drill into one failing request without hand-joining by `traceId`

Recommended flow in Grafana:

1. Open `Explore`.
2. Pick the `Tempo` data source.
3. Set the time range to something recent like `Last 15 minutes`.
4. Start broad. Do not begin with a very narrow query.
5. Look for spans from your configured service name, then narrow by span name or attributes.

Good first searches:

- service name such as `akeru-local`, `akeru-dev`, or `akeru-desktop`
- span names like `sendTurn` or a Git operation such as `GitVcsDriver.statusDetails.status`
- Git spans whose `git.operation` attribute identifies the operation
- orchestration spans with attributes like `orchestration.command_type`

Once you know traces are arriving, narrower TraceQL queries for names such as `sendTurn` or Git
operation names become useful.

### Use Metrics To See Systemic Problems

Traces are best for one request. Metrics are best for trends.

Good metric families to watch:

- `t3_rpc_request_duration`
- `t3_orchestration_command_duration`
- `t3_orchestration_command_ack_duration`
- `t3_provider_turn_duration`
- `t3_git_command_duration`

Counters tell you volume and failure rate:

- `t3_rpc_requests_total`
- `t3_orchestration_commands_total`
- `t3_provider_turns_total`
- `t3_git_commands_total`

Use metrics when the question is:

- "is this always slow?"
- "did this get worse after a change?"
- "which command type is failing most often?"

Use traces when the question is:

- "what happened in this specific request?"
- "which child span caused this one slow interaction?"
- "what logs were emitted inside the failing flow?"

### What The New Ack Metric Means

`t3_orchestration_command_ack_duration` measures:

- start: command dispatch enters the orchestration engine
- end: the first committed domain event for that command is published by the server

That is a server-side acknowledgment metric. It does not measure:

- websocket transit to the browser
- client receipt
- React render time

If you need those later, add client-side instrumentation or a dedicated server fanout metric.

## Common Workflows

### "Why did this request fail?"

1. Start with the local NDJSON file.
2. Find `effect-span` records where `exit._tag != "Success"`.
3. Group by `traceId`.
4. Inspect sibling spans and span events.
5. If needed, move to Tempo for the full trace tree.

### "Why is the UI feeling slow?"

1. Search for slow top-level spans in the trace file or Tempo.
2. Check child spans for sqlite, git, or provider work.
3. Look at the matching duration metrics to see whether the slowness is systemic.

### "Did this command take too long to acknowledge?"

1. Check `t3_orchestration_command_ack_duration` by `commandType`.
2. If it is high, inspect the corresponding orchestration trace.
3. Look at child spans for projection, sqlite, provider, or git work.

### "Are git hooks causing latency?"

1. Filter `git.operation` spans.
2. Inspect `git.hook.started` and `git.hook.finished` events.
3. Compare hook timing to the enclosing git span duration.

### "Why do I have spans locally but nothing in Grafana?"

Usually one of these is true:

- `AKERU_OTLP_TRACES_URL` was not set
- the app was launched from a different environment than the one where you exported the vars
- the app was not fully restarted after changing env
- Grafana is looking at the wrong time range or service name

If the local NDJSON file is updating, local tracing is working. The problem is almost always OTLP export configuration or process startup.

## How To Think About Adding Tracing To Future Code

See [adding instrumentation](../internals/observability.md#how-to-think-about-adding-tracing-to-future-code)
for span boundaries, cardinality, and the pipeable metrics API.

## Detailed API Reference

See [the instrumentation reference](../internals/observability.md#detailed-api-reference)
for runtime wiring, environment variables, and the instrumentation inventory.
