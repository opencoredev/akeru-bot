/** Turns a raw provider or orchestration error into chat-facing copy shared by web and mobile. */
export interface ThreadErrorPresentation {
  readonly title: string;
  readonly description: string;
  readonly technicalDetails: string;
  /** Only an unexplained failure asks for feedback; known causes name their own fix. */
  readonly action: "providers" | "feedback" | "none";
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi For Coding",
  opencode: "OpenCode",
};

function providerName(id: string): string {
  return PROVIDER_NAMES[id.toLowerCase()] ?? id;
}

function boundedTechnicalDetails(error: string): string {
  const firstLine = error.split("\n", 1)[0]?.trim() ?? error.trim();
  const withoutStack = firstLine.replace(/\s+at\s+[A-Za-z_$][\s\S]*$/, "").trim();
  const withoutLocalPaths = withoutStack.replace(/file:\/\/\/[^\s)]+/g, "file://…");
  return withoutLocalPaths.slice(0, 600);
}

export function presentThreadError(error: string): ThreadErrorPresentation {
  const disabledProvider = error.match(/Provider instance ['"]([^'"]+)['"] is disabled/i);
  if (disabledProvider?.[1]) {
    const name = providerName(disabledProvider[1]);
    return {
      title: `${name} is turned off`,
      description: `Enable ${name} in Settings, then send your message again.`,
      technicalDetails: `Provider instance “${disabledProvider[1]}” is disabled.`,
      action: "providers",
    };
  }

  if (/Bot '[^']+' is archived/.test(error)) {
    return {
      title: "This bot is archived",
      description: "Restore it from the roster to chat with it again.",
      technicalDetails: boundedTechnicalDetails(error),
      action: "none",
    };
  }

  if (/rate.?limit|usage limit|too many requests|quota exceeded/i.test(error)) {
    return {
      title: "Request limit reached",
      description: "Wait a moment, then send your message again.",
      technicalDetails: boundedTechnicalDetails(error),
      action: "none",
    };
  }

  if (/not authenticated|authentication required|unauthorized|invalid api key/i.test(error)) {
    return {
      title: "Provider sign-in required",
      description: "Reconnect the provider in Settings, then try again.",
      technicalDetails: boundedTechnicalDetails(error),
      action: "providers",
    };
  }

  if (/network|connection|socket|fetch failed|disconnected/i.test(error)) {
    return {
      title: "Connection interrupted",
      description: "Check the environment connection, then send your message again.",
      technicalDetails: boundedTechnicalDetails(error),
      action: "none",
    };
  }

  return {
    title: "The bot couldn’t finish that request",
    description:
      "Try sending it again. If it keeps happening, send feedback with the technical details.",
    technicalDetails: boundedTechnicalDetails(error),
    action: "feedback",
  };
}
