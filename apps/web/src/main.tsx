import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { LanguageProvider, type TestLanguageCatalog } from "./i18n";

// Browser verification injects this before navigation; production builds ignore it.
const testLanguageCatalog = import.meta.env.DEV
  ? (window as Window & { __AKERU_TEST_I18N__?: TestLanguageCatalog }).__AKERU_TEST_I18N__
  : undefined;

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider testCatalog={testLanguageCatalog}>
      <AppRoot router={router} />
    </LanguageProvider>
  </React.StrictMode>,
);

if (import.meta.env.DEV) {
  void import("react-grab");
}
