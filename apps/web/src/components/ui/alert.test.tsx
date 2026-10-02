import { Fragment, memo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";

describe("alert children", () => {
  it("renders fragments without reading component metadata from a symbol", () => {
    const html = renderToStaticMarkup(
      <Alert>
        <Fragment>
          <AlertDescription>Message</AlertDescription>
        </Fragment>
      </Alert>,
    );

    expect(html).toContain("Message");
    expect(html).toContain('data-slot="alert-description"');
  });

  it("keeps native, function, and memo children in their existing slots", () => {
    const MemoTitle = memo(AlertTitle);
    MemoTitle.displayName = "AlertTitle";

    const html = renderToStaticMarkup(
      <Alert>
        <svg aria-label="Notice" />
        <MemoTitle>Title</MemoTitle>
        <AlertDescription>Description</AlertDescription>
        <AlertAction>Action</AlertAction>
      </Alert>,
    );

    expect(html.indexOf("Notice")).toBeLessThan(html.indexOf("Title"));
    expect(html.indexOf("Title")).toBeLessThan(html.indexOf("Description"));
    expect(html.indexOf("Description")).toBeLessThan(html.indexOf("Action"));
  });
});
