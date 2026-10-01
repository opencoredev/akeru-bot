import * as CodexSchema from "effect-codex-app-server/schema";

export function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;

  if (account.type === "apiKey") return "OpenAI API Key";

  if (account.type === "amazonBedrock") return "Amazon Bedrock";

  if (account.type !== "chatgpt") return undefined;

  switch (account.planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_prolite":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      account.planType satisfies never;

      return undefined;
  }
}

export function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;

  return account.email;
}
