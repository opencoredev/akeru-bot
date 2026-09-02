import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    // Deploy pushes to main; every other branch stays manual.
    deploymentEnabled: {
      main: true,
      "*": false,
    },
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  routes: [
    {
      src: "^/(.*)$",
      headers: {
        Link: '</sitemap.xml>; rel="sitemap"; type="application/xml", </index.md>; rel="alternate"; type="text/markdown", </openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json", </.well-known/ard.json>; rel="api-catalog"; type="application/json", </feedback.md>; rel="help"; type="text/markdown"',
        Vary: "Accept, Accept-Encoding",
      },
      continue: true,
    },
    {
      // Published quota for the public metadata API, as the IETF RateLimit
      // header fields, so agents can self-throttle. The CDN serves these
      // documents statically, so the remaining count matches the policy.
      src: "^/(?:v\\d+/)?(?:schema/.*|openapi\\.json)$",
      headers: {
        "RateLimit-Policy": '"default";q=600;w=60',
        RateLimit: '"default";r=600;t=60',
      },
      continue: true,
    },
    {
      src: "^/feedback\\.md$",
      dest: "/feedback.md",
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    },
    {
      src: "^/$",
      has: [{ type: "header", key: "accept", value: "text/markdown" }],
      dest: "/index.md",
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        Vary: "Accept, Accept-Encoding",
      },
    },
    { handle: "filesystem" },
    {
      src: "^/api(?:/.*)?$",
      dest: "/api-error.json",
      status: 404,
      headers: {
        "Content-Type": "application/problem+json; charset=utf-8",
        "RateLimit-Policy": '"default";q=600;w=60',
        RateLimit: '"default";r=600;t=60',
      },
    },
    {
      src: "^/.*$",
      has: [{ type: "header", key: "accept", value: "text/markdown" }],
      dest: "/404.md",
      status: 404,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    },
    { src: "^/.*$", dest: "/404.html", status: 404 },
  ],
};
