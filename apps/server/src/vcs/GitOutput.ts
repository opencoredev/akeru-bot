export function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();

  for (const line of output.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);

    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];

    if (!name || !url || !direction) {
      continue;
    }

    const remote = remotes.get(name) ?? {};

    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }

    remotes.set(name, remote);
  }

  return remotes;
}
