import { matchers, routes, type VercelConfig } from "@vercel/config/v1";

const ROUTER_HOST = "app.t3.codes";
const LATEST_ORIGIN = "https://latest.app.t3.codes";

export const config: VercelConfig = {
  buildCommand:
    "vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts production",
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: [
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST)],
      dest: `${LATEST_ORIGIN}/$1`,
    },
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
