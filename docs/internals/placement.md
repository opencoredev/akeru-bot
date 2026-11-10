# Environment descriptors and placement

> For maintainers. Using Akeru Bot? See [docs/user](../user/).

A user can connect several environments at once: a laptop, a Mac mini, a
Linux server. Work that needs macOS and Xcode has to run on the Mac. This page
covers the three pieces that make that possible: each environment describes
its machine, each bot lists where it may run, and a pure function picks an
environment from those two inputs.

Status: descriptors, allowed environments, the placement function, and the
`list_environments` bot tool are implemented. Clients do not call placement
yet, and there is no settings UI for labels, notes, or weights. See
[Follow-ups](#follow-ups).

## Environment host descriptor

`EnvironmentHostDescriptor` in `packages/contracts/src/environmentHost.ts` says
what one environment's machine can do right now. Each server describes only
itself, and clients collect one descriptor per connected environment.

| Field                                | Source                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environmentId`, `label`, `platform` | `ServerEnvironment.getDescriptor`. `platform.os` uses the existing vocabulary, so macOS is `"darwin"`.                                                                                                                                                          |
| `cpuCount`                           | `os.availableParallelism()`                                                                                                                                                                                                                                     |
| `load`                               | CPU utilization from two `os.cpus()` readings, free and total memory, and `sampleAgeMs`, the reading's age when the server sent it. `null` when no CPU time passed between readings. See [How the server reads the machine](#how-the-server-reads-the-machine). |
| `tools`                              | File checks for `xcodebuild`, `docker`, `nvidia-smi`, `git`, `chrome`, `chromium`, `firefox`, `safari`, and `edge`                                                                                                                                              |
| `providers`                          | `ProviderRegistry.getProviders`, with `ready` from `isProviderReady`, which runs the turn-start preflight with live account and request health. A usage cap or an active rate limit reports not ready until its retry time passes.                              |
| `projects`                           | Live (not deleted) rows from `ProjectionProjectRepository`                                                                                                                                                                                                      |
| `profile`                            | `ServerSettings.environmentHost`: the owner's `labels`, `note`, and `placementWeight`. A failed settings read keeps the last good profile. If settings were never readable, the profile is empty and `manual-only`.                                             |

### How the server reads the machine

`EnvironmentHost` in `apps/server/src/environment/EnvironmentHost.ts` builds
the descriptor. It never starts a subprocess.

- **Tools** come from `detectEnvironmentHostTools` in `EnvironmentHostTools.ts`.
  It checks whether files exist on `PATH` (with `.exe` on Windows) and at fixed
  install locations, such as `/Applications/Safari.app`. The result is cached
  for 10 minutes.
- **Xcode and git on macOS** need care, because `/usr/bin/xcodebuild` and
  `/usr/bin/git` are Apple's stubs: they work only when a developer directory
  exists, and otherwise offer to install one. So PATH hits in `/usr/bin` do not
  count. Instead the probe looks for the real binary under `usr/bin` of each
  developer directory, in this order:
  1. any other `PATH` directory, such as
     `/Applications/Xcode_26.0.app/Contents/Developer/usr/bin`;
  2. `DEVELOPER_DIR`, as the app bundle or its `Contents/Developer`;
  3. `/var/db/xcode_select_link`, the symlink `xcode-select --switch` writes;
  4. `/Applications/Xcode.app` and `/Applications/Xcode-beta.app`.

  The command line tools ship git but not `xcodebuild`, so selecting them
  reports `git` only. `xcodebuild` is never reported off macOS.

- **Load** is sampled when someone asks. A reading less than 1 second old is
  returned as-is. Otherwise CPU use is measured against the previous reading.
  When that reading is missing or more than 10 seconds old, the server takes
  two readings 250 ms apart. No background timer runs. On Linux, CPU time comes
  from the `cpuN` lines of `/proc/stat` whose ids are in `Cpus_allowed_list`
  from `/proc/self/status`, the same set `os.availableParallelism()` counts, so
  a container pinned to a few cores of a large host reports its own load. The
  ids come from `/proc/stat` because `os.cpus()` packs online CPUs densely. The
  affinity is read on every sample, and two readings over different CPU sets
  are never compared, so a `taskset` or cpuset change gives one `null` load
  until a new baseline exists.
- **Memory** on Linux is `MemAvailable` from `/proc/meminfo` and
  `os.totalmem()`, capped by the tightest cgroup memory limit on the process's
  cgroup v2 group or its parents (or, without a v2 limit, its cgroup v1 memory
  group or its parents, from the `memory` line of `/proc/self/cgroup`). A Docker
  `--memory` limit or a systemd `MemoryMax=` therefore shows as the total, and
  free memory is the limit minus use, with inactive file cache counted as free.
  The smallest limit and the least free memory are taken separately, since a
  tight child group can sit inside a fuller parent.
  Other platforms use `os.freemem()` and `os.totalmem()`.
- The machine readings sit behind `EnvironmentHostMachine`, so tests pass a
  fake probe and drive time with `TestClock`.

`server.getEnvironmentHost` serves the descriptor over the WebSocket RPC. It
needs `orchestration:read`, like `server.getConfig`. Project roots and tool
names are already visible to that scope through the shell snapshot.

### Owner profile

The owner describes an environment in that environment's server settings:

```json
{
  "environmentHost": {
    "labels": ["mac-mini", "xcode"],
    "note": "Builds iOS apps.",
    "placementWeight": "prefer"
  }
}
```

Clients change it through `server.updateSettings` with an `environmentHost`
patch, which needs `orchestration:operate` like every other settings write.
Labels are trimmed, unique, at most 12, and at most 32 characters each. The
note is at most 280 characters. To clear the description, send
`CLEAR_ENVIRONMENT_HOST_DESCRIPTION_PATCH` (`labels: []`, `note: ""`). That
keeps the weight; set `placementWeight: "normal"` to reset the weight too.

The weight lives with the environment rather than in each client, so every
client and bot sees the same value.

| `placementWeight`  | Factor                                        |
| ------------------ | --------------------------------------------- |
| `prefer`           | 2                                             |
| `normal` (default) | 1                                             |
| `less-often`       | 0.5                                           |
| `manual-only`      | 0. Only a user's explicit choice can pick it. |

## Allowed environments

`OrchestrationBot.allowedEnvironmentIds` lists the other environments a bot
may run work on. Its home environment, the one that owns the bot, is always
allowed and never appears in the list, so the empty default means "home
only". Read it through `botAllowedEnvironmentIds(bot)`, which returns `[]`
when the field is absent.

The field follows the bot profile path:

- `bot.update` (server and client command) takes `allowedEnvironmentIds` and
  replaces the whole list. Sending `[]` returns the bot to home only.
- `bot.created` always carries `[]`. `bot.updated` carries the list only when
  the command set it.
- The projector, the SQL projection, and the shell stream copy it through.
- Migration 74 adds `projection_bots.allowed_environment_ids_json` with
  default `'[]'`, so every existing bot stays home only.

The list holds at most 32 unique ids. It is not part of bot portability
archives, because environment ids belong to one user's machines.

## Placement

`placeWork` in `packages/shared/src/environmentPlacement.ts` decides where work
runs. It lives in `@akeru/shared`, not `@akeru/client-runtime`, because the
server's `list_environments` tool and the clients both call it, and the server
does not depend on client code.

The function is pure. The caller passes `nowMs`, the bot's home and allowed
environments, one `PlacementCandidate` per known environment (`online` with a
descriptor and the `receivedAtMs` when it arrived, `offline`, or
`undescribed`), and optional `requirements`,
`provider`, `userChoice`, and `botChoice`.

### Eligibility

An environment is eligible only when all of these hold. Every failure is
reported, not just the first.

1. It is the bot's home or in its allowed list (`not-allowed`).
2. It is connected (`offline`) and has sent a descriptor (`no-descriptor`).
   Allowed environments the caller does not know about are reported as
   `offline`.
3. Its load reading is at most 15 seconds old (`stale-load`). A descriptor
   with `load: null` stays eligible with unknown load. See
   [Load freshness](#load-freshness).
4. It meets every requirement: `os`, `arch`, all `tools`, all `labels`
   (ignoring case), and `project` (`os-mismatch`, `arch-mismatch`,
   `missing-tools`, `missing-labels`, `missing-project`). A project matches by
   title or the last segment of its root, ignoring case, because one
   repository usually sits at different paths on different machines.
5. When `provider` is set, it has a ready instance of that driver
   (`provider-not-ready`).

### Load freshness

Machines' clocks disagree, sometimes by minutes, so placement never subtracts
one machine's timestamp from another's. The server reports `sampleAgeMs`, the
reading's age on its own clock at the moment it sends the descriptor. The
caller records `receivedAtMs` on its own clock when the descriptor arrives and
passes its own `nowMs`. `placementLoadAgeMs` adds the two durations:

```text
age = sampleAgeMs + max(0, nowMs − receivedAtMs)
```

A server clock that runs behind or ahead does not change the result. A
`receivedAtMs` in the caller's future counts as zero, so it cannot make a
reading younger than the server said. Ignoring network latency makes a reading
look a little fresher than it is, by the one-way delay of the response.

### Choice

1. **User choice.** An eligible choice wins, including a manual-only or busy
   host. A choice outside the eligible set returns `choice-ineligible` with its
   exclusions. It never overrides eligibility.
2. **Bot choice.** Used when eligible and not manual-only. Otherwise it is
   reported as `rejectedBotChoice` and placement continues.
3. **Score.** Among hosts with known load:
   `weight × cpuCount × (1 − cpuUtilization) × (availableMemory / totalMemory)`.
   Hosts at or above 95% CPU (`cpu-overloaded`) or at or below 5% free memory
   (`memory-low`) are skipped, as are manual-only hosts. Equal scores go to the
   home environment, then to the lower environment id.
4. **Unknown load.** Only when no host could be scored: the highest weight,
   then home, then the lower id.
5. Otherwise the result is `unplaced`.

Every result carries `candidates`, one `PlacementCandidateReport` per
environment: `excluded` with its reasons, or `eligible` with a ranking
(`scored`, `unknown-load`, or `skipped`). `placementExclusionText` turns a
reason into one English sentence.

`environmentPlacement.test.ts` covers requirements, stale load, overload, low
memory, manual-only, explicit choices outside the eligible set, bot choices,
weights, and ties.

## `list_environments` bot tool

Bots on the Mastra controller get `list_environments` from the catalog. It
takes optional `requirements` and returns:

- `eligible`: compact descriptors (OS, architecture, CPU count, rounded CPU use
  and free memory share, tools, ready provider drivers, project titles, labels,
  note, weight, and how automatic placement ranks it);
- `excluded`: each other environment with readable reasons.

It needs no approval and resolves as a `read` tool.
`apps/server/src/provider/tools/AkeruEnvironmentTools.ts` builds the result
with `placementCandidates`, so the bot sees the same rules a client applies.

A server only knows its own descriptor. The tool therefore lists the local
environment, reports the bot's other allowed environments as not connected,
and adds a `visibility` note saying so. `ListEnvironmentsDependencies.remoteCandidates`
is the seam where cross-environment discovery will supply peer descriptors.
The session gets the tool only when the `EnvironmentHost` service is present,
which keeps controller test layers free of machine readings.

## Follow-ups

- **Client placement.** Clients hold several environments in
  `EnvironmentRegistry`. A follow-up fetches `server.getEnvironmentHost` per
  connected environment, polls while placement is in use so load stays inside
  the 15-second window, and calls `placeWork` when the user hands off work.
- **Peer descriptors on the server.** Fill `remoteCandidates` so a bot can see
  and pick another environment.
- **Settings UI.** Rows for labels, note, and weight per environment, and a
  bot setting for allowed environments. Today these are set only through
  `server.updateSettings` and `bot.update`.
