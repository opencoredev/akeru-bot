# Server observability instrumentation

For launch, artifact locations, and diagnosis, see the [observability runbook](../operations/observability.md).
This page covers adding instrumentation and the server runtime configuration.

## How To Think About Adding Tracing To Future Code

### Prefer Boundaries Over Tiny Helpers

Good span boundaries:

- RPC methods
- orchestration command handling
- provider adapter calls
- external process calls
- persistence writes
- queue handoffs

Avoid tracing every tiny helper. Most helpers should inherit the active span rather than create a new one.

### Reuse `Effect.fn(...)` Where It Already Exists

The codebase already uses `Effect.fn("name")` heavily. That should usually be your first tracing boundary.

For ad hoc work:

```ts
import { Effect } from "effect";

const runThing = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({
    "thing.id": "abc123",
    "thing.kind": "example",
  });

  yield* Effect.logInfo("starting thing");
  return yield* doWork();
}).pipe(Effect.withSpan("thing.run"));
```

### Put High-Cardinality Detail On Spans

Use span annotations for IDs, paths, and other detailed context:

```ts
yield *
  Effect.annotateCurrentSpan({
    "provider.thread_id": input.threadId,
    "provider.request_id": input.requestId,
    "git.cwd": input.cwd,
  });
```

### Keep Metric Labels Low Cardinality

Good metric labels:

- operation kind
- method name
- provider kind
- aggregate kind
- outcome

Bad metric labels:

- raw thread IDs
- command IDs
- file paths
- cwd
- full prompts
- full model strings when a normalized family label would do

Detailed context belongs on spans, not metrics.

### Use Logs As Span Events

Logs inside a span become part of the trace story:

```ts
yield * Effect.logInfo("starting provider turn");
yield * Effect.logDebug("waiting for approval response");
```

Those messages show up as span events because `Logger.tracerLogger` is installed.

### Use The Pipeable Metrics API

`withMetrics(...)` is the default way to attach a counter and timer to an effect:

```ts
import { someCounter, someDuration, withMetrics } from "../observability/Metrics.ts";

const program = doWork().pipe(
  withMetrics({
    counter: someCounter,
    timer: someDuration,
    attributes: {
      operation: "work",
    },
  }),
);
```

## Detailed API Reference

### Runtime Wiring

The server observability layer is assembled in `apps/server/src/observability/Layers/Observability.ts`.

It provides:

- pretty stdout logger
- `Logger.tracerLogger`
- local NDJSON tracer
- optional OTLP trace exporter
- optional OTLP metrics exporter
- Effect trace-level and timing refs

### Env Vars

Each variable also accepts its older `T3CODE_` name, for example `T3CODE_OTLP_TRACES_URL`. The
`AKERU_` name wins when both are set.

Local trace file:

- `AKERU_TRACE_FILE`: override trace file path
- `AKERU_TRACE_MAX_BYTES`: per-file rotation size, default `10485760`
- `AKERU_TRACE_MAX_FILES`: rotated file count, default `10`
- `AKERU_TRACE_BATCH_WINDOW_MS`: flush window, default `1000`
- `AKERU_TRACE_MIN_LEVEL`: minimum trace level, default `Info`
- `AKERU_TRACE_TIMING_ENABLED`: enable timing metadata, default `true`

OTLP export:

- `AKERU_OTLP_TRACES_URL`: OTLP trace endpoint
- `AKERU_OTLP_METRICS_URL`: OTLP metric endpoint
- `AKERU_OTLP_EXPORT_INTERVAL_MS`: export interval, default `10000`
- `AKERU_OTLP_SERVICE_NAME`: service name, default `akeru-server`

If the OTLP URLs are unset, local tracing still works and metrics stay in-process only.

### What Is Instrumented Today

Current high-value span and metric boundaries include:

- Effect RPC websocket request spans from `effect/rpc`
- RPC request metrics in `apps/server/src/observability/RpcInstrumentation.ts`
- startup phases
- orchestration command processing
- orchestration command acknowledgment latency
- provider session and turn operations
- git command execution and git hook events
- sqlite query execution

### Current Constraints

- logs outside spans are not persisted in the trace file; SSH-managed launch stdout/stderr is still
  captured in its launcher log
- metrics are not snapshotted locally
- the old `serverLogPath` still exists in config for compatibility, but the trace file is the primary
  structured persisted artifact
