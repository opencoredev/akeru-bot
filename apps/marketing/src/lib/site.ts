export const GITHUB_REPOSITORY_URL = "https://github.com/opencoredev/akeru-bot";
export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";

/** User docs live in the repository, so every docs link points at GitHub. */
export const DOCS_URL = `${GITHUB_REPOSITORY_URL}/tree/main/docs/user`;

/** `docsUrl("install")` resolves to docs/user/install.md on the default branch. */
export function docsUrl(page: string): string {
  return `${GITHUB_REPOSITORY_URL}/blob/main/docs/user/${page}.md`;
}
