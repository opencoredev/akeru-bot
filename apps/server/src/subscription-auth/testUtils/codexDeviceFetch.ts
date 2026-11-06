import { vi } from "vite-plus/test";

/** A fetch that answers a Codex device sign-in in one poll: user code, device token, then the token exchange. */
export function codexDeviceFetch(accessToken = "late-access", accountId = "account") {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

    const body = url.endsWith("/deviceauth/usercode")
      ? { device_auth_id: "device", user_code: "user", interval: 1 }
      : url.endsWith("/deviceauth/token")
        ? { authorization_code: "code", code_verifier: "verifier" }
        : {
            access_token: accessToken,
            refresh_token: "refresh",
            expires_in: 3600,
            id_token: `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.signature`,
          };

    return Response.json(body);
  });
}
