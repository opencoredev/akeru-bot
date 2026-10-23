import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// The Worker serves this build as static assets from apps/cloud/dist/web. The
// SPA is same-origin with the API, so no API origin is baked into the bundle.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
