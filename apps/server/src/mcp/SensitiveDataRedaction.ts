const REDACTED = "[REDACTED]";

const sensitivePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
  /\bBearer\s+[A-Z0-9._~+/-]+=*/gi,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs]|AKIA|glpat|npm)[-_A-Z0-9]{8,}\b/gi,
  /\beyJ[A-Z0-9_-]+\.[A-Z0-9_-]+\.[A-Z0-9_-]+\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|session(?:Id)?|clientSecret|aws[_-]?secret[_-]?access[_-]?key)\b\s*[:=]\s*[^\r\n,}]+/gi,
  /\/Users\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g,
  /\/home\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g,
  /\/root(?:\/[^\s"'<>]*)?/g,
  /~\/(?:[^\s"'<>]*)?/g,
  /\b[A-Z]:\\Users\\[^\\\s"'<>]+(?:\\[^\s"'<>]*)?/gi,
  /%2F(?:Users|home)%2F[^\s"'<>]+/gi,
  /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g,
  /(?<![A-Z0-9])\d{10}(?![A-Z0-9])/gi,
  /(?<![A-Z0-9])\+\d{10,15}(?![A-Z0-9])/gi,
  /\+\d{1,3}(?:[-.\s]\d{2,4}){3,5}\b/g,
] as const;

export function redactSensitiveText(value: string) {
  let redacted = false;
  let next = value;
  for (const pattern of sensitivePatterns) {
    next = next.replaceAll(pattern, () => {
      redacted = true;
      return REDACTED;
    });
  }
  return { value: next, redacted };
}
