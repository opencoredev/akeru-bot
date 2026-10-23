import * as Schema from "effect/Schema";
import { ClerkProvider } from "@clerk/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./styles.css";

// The publishable key comes from the Worker at runtime, so one build serves every stage.
const decodeConfig = Schema.decodeUnknownSync(
  Schema.Struct({ clerkPublishableKey: Schema.String }),
);

function Root() {
  const [key, setKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch("/api/config")
      .then(async (response) => decodeConfig(await response.json()))
      .then((config) => setKey(config.clerkPublishableKey))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <p className="page muted">Akeru Cloud is unavailable. Try again shortly.</p>;

  if (!key) return null;

  return (
    <ClerkProvider publishableKey={key} afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
