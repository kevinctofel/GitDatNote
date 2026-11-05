import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { __setDevPreviewMarkdown } from "./preview-overrides";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('Missing "#root" element');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Expose the dev-only preview override to the foundation task 2.7 browser
// security tests. Production builds do not expose it, and the hook is a
// no-op outside dev mode, so it can never affect real user content.
if (import.meta.env.DEV) {
  (
    globalThis as unknown as {
      __setDevPreviewMarkdown: typeof __setDevPreviewMarkdown;
    }
  ).__setDevPreviewMarkdown = __setDevPreviewMarkdown;
}
