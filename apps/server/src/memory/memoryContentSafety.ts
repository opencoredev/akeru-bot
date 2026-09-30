const invisibleCharacters = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;
const threatPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bignore\s+(?:all\s+)?(?:(?:previous|prior)\s+)?(?:system\s+|developer\s+)?instructions?\b/iu,
    "instruction override",
  ],
  [
    /\b(?:reveal|print|show|repeat|exfiltrate)\b.{0,48}\b(?:system prompt|developer message|hidden instructions?)\b/iu,
    "prompt exfiltration",
  ],
  [/<\/?(?:system|developer|assistant)(?:\s|>)/iu, "forged prompt role"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, "private key"],
  [/\b(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/u, "credential"],
  [/\bAKIA[0-9A-Z]{16}\b/u, "credential"],
];

export function scanMemoryContent(content: string): ReadonlyArray<string> {
  const findings: string[] = [];
  if (invisibleCharacters.test(content)) findings.push("invisible Unicode control characters");
  for (const [pattern, label] of threatPatterns) {
    if (pattern.test(content)) findings.push(label);
  }
  return findings;
}
