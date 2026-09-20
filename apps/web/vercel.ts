import { routes, type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  buildCommand:
    "vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts production",
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
