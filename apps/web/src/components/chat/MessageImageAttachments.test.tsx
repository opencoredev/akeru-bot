import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { MessageImageAttachments } from "./MessageImageAttachments";

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrls: () => ["http://localhost/api/assets/browser-screenshot.png"],
}));

describe("MessageImageAttachments", () => {
  it("renders a persisted attachment as an expandable image", () => {
    const markup = renderToStaticMarkup(
      <MessageImageAttachments
        environmentId={"environment-1" as EnvironmentId}
        attachments={[
          {
            type: "image",
            id: "thread-1-00000000-0000-4000-8000-000000000001",
            name: "browser-screenshot.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        ]}
      />,
    );

    expect(markup).toContain('data-testid="message-image-attachments"');
    expect(markup).toContain('aria-label="Preview browser-screenshot.png"');
    expect(markup).toContain('src="http://localhost/api/assets/browser-screenshot.png"');
  });
});
