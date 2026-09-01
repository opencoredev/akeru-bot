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
  headers: [
    {
      source: "/(.*)",
      headers: [
        { key: "Vary", value: "Accept, Accept-Encoding" },
        {
          key: "Link",
          value:
            '</sitemap.xml>; rel="sitemap"; type="application/xml", </llms.txt>; rel="describedby"; type="text/markdown", </.well-known/ard.json>; rel="api-catalog"; type="application/json"',
        },
      ],
    },
    {
      source: "/index.md",
      headers: [{ key: "Content-Type", value: "text/markdown; charset=utf-8" }],
    },
  ],
  rewrites: [
    {
      source: "/",
      destination: "/index.md",
      has: [{ type: "header", key: "accept", value: ".*text/markdown.*" }],
    },
  ],
};
