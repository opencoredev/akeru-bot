import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashMenu } from "./ComposerStashMenu";

describe("ComposerStashMenu", () => {
  it("renders saved prompts as an attached composer drawer", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-stash-drawer="true"');
    expect(markup).toContain('data-composer-banner-surface="attached"');
    expect(markup).toContain('aria-label="Close stash"');
    expect(markup).toContain('aria-label="Stashed prompts"');
    expect(markup).toContain("Nothing stashed yet.");
  });

  it("shows saved image thumbnails and incomplete image states", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "with-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Compare these screenshots",
            attachments: [
              {
                id: "image-one",
                name: "before.png",
                mimeType: "image/png",
                sizeBytes: 128,
                dataUrl: "data:image/png;base64,AA==",
              },
            ],
            droppedImageNames: ["after.png"],
            unreadableImageNames: [],
            pendingImageCount: 0,
          },
          {
            id: "saving-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Save this image",
            attachments: [],
            droppedImageNames: [],
            unreadableImageNames: [],
            pendingImageCount: 1,
          },
        ]}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('src="data:image/png;base64,AA=="');
    expect(markup).toContain("1 image dropped");
    expect(markup).toContain("saving 1 image");
    expect(markup).toContain('data-stash-restore="with-images"');
    expect(markup).toContain('aria-label="Restore stashed prompt: Compare these screenshots"');
    expect(markup).toContain('aria-label="Delete stashed prompt"');
    expect(markup).toContain('dateTime="1970-01-01T00:00:00.000Z"');
  });
});
