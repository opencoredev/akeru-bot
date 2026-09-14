// @effect-diagnostics cryptoRandomUUID:off globalConsole:off globalDate:off
import type { StoredProductFeedbackSubmission } from "@t3tools/contracts";
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

export interface FeedbackDeliveryRecord {
  readonly feedbackId: string;
  readonly claimId: string;
  readonly receivedAt: string;
  readonly deliveryAttempts: number;
  readonly submission: StoredProductFeedbackSubmission;
}

export interface FeedbackDeliveryOutbox {
  readonly claim: (
    feedbackId: string,
    claimId: string,
    now: string,
    leaseExpiresAt: string,
  ) => Promise<FeedbackDeliveryRecord | null>;
  readonly listEligible: (now: string, limit: number) => Promise<readonly string[]>;
  readonly markDelivered: (
    feedbackId: string,
    claimId: string,
    issueNumber: number,
    issueUrl: string,
  ) => Promise<void>;
  readonly markFailed: (
    feedbackId: string,
    claimId: string,
    nextAttemptAt: string,
    errorCode: string,
  ) => Promise<void>;
  readonly markUnknown: (feedbackId: string, claimId: string, errorCode: string) => Promise<void>;
  readonly countUnknown: () => Promise<number>;
}

export interface GitHubIssueDestination {
  readonly repository: string;
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
}

interface GitHubIssueReceipt {
  readonly kind: "delivered";
  readonly number: number;
  readonly htmlUrl: string;
}

interface GitHubIssueFailure {
  readonly kind: "failed";
  readonly errorCode: string;
}

interface GitHubIssueUnknown {
  readonly kind: "unknown";
  readonly errorCode: string;
}

const DELIVERY_LEASE_MILLISECONDS = 60_000;
const GITHUB_REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const MAX_DELIVERY_BATCH = 10;
const MAX_RETRY_DELAY_MILLISECONDS = 86_400_000;
const GITHUB_API_VERSION = "2026-03-10";

function indentedCode(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export function formatGitHubIssue(record: FeedbackDeliveryRecord): {
  readonly title: string;
  readonly body: string;
} {
  const summary = record.submission.feedback.replace(/\s+/g, " ").trim().slice(0, 96);
  const element = record.submission.element;
  const body = [
    "## Feedback",
    "",
    indentedCode(record.submission.feedback),
    "",
    ...(element
      ? [
          "## Selected element",
          "",
          indentedCode(
            [
              `Selector: ${element.selector}`,
              ...(element.component ? [`Component: ${element.component}`] : []),
              ...(element.source ? [`Source: ${element.source}`] : []),
              ...(element.role ? [`Role: ${element.role}`] : []),
              ...(element.label ? [`Label: ${element.label}`] : []),
            ].join("\n"),
          ),
          "",
        ]
      : []),
    "## Submission",
    "",
    `- Feedback ID: \`${record.feedbackId}\``,
    `- Received: \`${record.receivedAt}\``,
  ].join("\n");
  return {
    title: `[Akeru feedback] ${summary || record.feedbackId}`,
    body,
  };
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "akeru-feedback",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

function base64UrlJson(value: unknown): string {
  return NodeBuffer.Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createGitHubAppJwt(
  appId: string,
  privateKey: string,
  now: Date = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: issuedAt, exp: issuedAt + 600, iss: appId });
  const unsigned = `${header}.${payload}`;
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    NodeBuffer.Buffer.from(unsigned),
    privateKey,
  ).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function createInstallationToken(
  destination: GitHubIssueDestination,
  request: typeof fetch,
  now: Date,
  signJwt: typeof createGitHubAppJwt,
): Promise<{ readonly kind: "authenticated"; readonly token: string } | GitHubIssueFailure> {
  if (!validRepository(destination.repository)) {
    return { kind: "failed", errorCode: "invalid_repository" };
  }
  const repositoryName = destination.repository.split("/")[1];
  if (!repositoryName) return { kind: "failed", errorCode: "invalid_repository" };
  let jwt: string;
  try {
    jwt = signJwt(destination.appId, destination.privateKey, now);
  } catch {
    return { kind: "failed", errorCode: "app_jwt_signing_error" };
  }
  let response: Response;
  try {
    response = await request(
      `https://api.github.com/app/installations/${destination.installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubHeaders(jwt),
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MILLISECONDS),
        body: JSON.stringify({
          repositories: [repositoryName],
          permissions: { issues: "write" },
        }),
      },
    );
  } catch {
    return { kind: "failed", errorCode: "installation_token_network_error" };
  }
  if (!response.ok) {
    return { kind: "failed", errorCode: `installation_token_http_${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", errorCode: "invalid_installation_token_receipt" };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("token" in body) ||
    typeof body.token !== "string" ||
    body.token.length === 0
  ) {
    return { kind: "failed", errorCode: "invalid_installation_token_receipt" };
  }
  return { kind: "authenticated", token: body.token };
}

function validRepository(repository: string): boolean {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository);
}

async function createGitHubIssue(
  destination: GitHubIssueDestination,
  token: string,
  record: FeedbackDeliveryRecord,
  request: typeof fetch,
): Promise<GitHubIssueReceipt | GitHubIssueFailure | GitHubIssueUnknown> {
  if (!validRepository(destination.repository)) {
    return { kind: "failed", errorCode: "invalid_repository" };
  }
  const repositoryUrl = `https://api.github.com/repos/${destination.repository}`;
  let issueResponse: Response;
  try {
    issueResponse = await request(`${repositoryUrl}/issues`, {
      method: "POST",
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MILLISECONDS),
      body: JSON.stringify(formatGitHubIssue(record)),
    });
  } catch {
    return { kind: "unknown", errorCode: "issue_network_error" };
  }
  if (!issueResponse.ok) {
    return { kind: "failed", errorCode: `issue_http_${issueResponse.status}` };
  }
  let issueBody: unknown;
  try {
    issueBody = await issueResponse.json();
  } catch {
    return { kind: "unknown", errorCode: "invalid_issue_receipt" };
  }
  if (
    typeof issueBody !== "object" ||
    issueBody === null ||
    !("number" in issueBody) ||
    typeof issueBody.number !== "number" ||
    !("html_url" in issueBody) ||
    typeof issueBody.html_url !== "string"
  ) {
    return { kind: "unknown", errorCode: "invalid_issue_receipt" };
  }
  return { kind: "delivered", number: issueBody.number, htmlUrl: issueBody.html_url };
}

function retryAt(now: Date, attempts: number): string {
  const delay = Math.min(300_000 * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MILLISECONDS);
  return new Date(now.getTime() + delay).toISOString();
}

export async function deliverFeedbackToGitHub(options: {
  readonly destination: GitHubIssueDestination;
  readonly feedbackId: string;
  readonly outbox: FeedbackDeliveryOutbox;
  readonly now?: () => Date;
  readonly request?: typeof fetch;
  readonly signJwt?: typeof createGitHubAppJwt;
  readonly claimId?: () => string;
}): Promise<void> {
  const current = (options.now ?? (() => new Date()))();
  const claimId = (options.claimId ?? (() => crypto.randomUUID()))();
  const record = await options.outbox.claim(
    options.feedbackId,
    claimId,
    current.toISOString(),
    new Date(current.getTime() + DELIVERY_LEASE_MILLISECONDS).toISOString(),
  );
  if (!record) return;
  const authenticated = await createInstallationToken(
    options.destination,
    options.request ?? fetch,
    current,
    options.signJwt ?? createGitHubAppJwt,
  );
  if (authenticated.kind === "failed") {
    await options.outbox.markFailed(
      record.feedbackId,
      record.claimId,
      retryAt(current, record.deliveryAttempts),
      authenticated.errorCode,
    );
    return;
  }
  const result = await createGitHubIssue(
    options.destination,
    authenticated.token,
    record,
    options.request ?? fetch,
  );
  if (result.kind === "failed") {
    await options.outbox.markFailed(
      record.feedbackId,
      record.claimId,
      retryAt(current, record.deliveryAttempts),
      result.errorCode,
    );
    return;
  }
  if (result.kind === "unknown") {
    await options.outbox.markUnknown(record.feedbackId, record.claimId, result.errorCode);
    console.error(
      JSON.stringify({
        event: "feedback.github_delivery_unknown",
        feedbackId: record.feedbackId,
        errorCode: result.errorCode,
      }),
    );
    return;
  }
  await options.outbox.markDelivered(
    record.feedbackId,
    record.claimId,
    result.number,
    result.htmlUrl,
  );
}

export async function drainFeedbackToGitHub(options: {
  readonly destination: GitHubIssueDestination;
  readonly outbox: FeedbackDeliveryOutbox;
  readonly now?: () => Date;
  readonly request?: typeof fetch;
}): Promise<void> {
  const now = options.now ?? (() => new Date());
  const ids = await options.outbox.listEligible(now().toISOString(), MAX_DELIVERY_BATCH);
  for (const feedbackId of ids) {
    await deliverFeedbackToGitHub({ ...options, feedbackId, now });
  }
}
