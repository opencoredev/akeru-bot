import { describe, expect, it } from "vite-plus/test";

import { buttonVariants } from "../ui/button";
import { badgeVariants } from "../ui/badge";
import { cn } from "../../lib/utils";

describe("settings control presentation precedence", () => {
  it("preserves the environment-variable Add button's size override", () => {
    expect(
      cn(buttonVariants({ size: "sm", variant: "outline", presentation: "environment-add" })),
    ).toBe(cn(buttonVariants({ size: "sm", variant: "outline" }), "h-7 gap-1.5 px-2 text-xs"));
  });

  it("preserves the compact connection-kind badge dimensions", () => {
    expect(cn(badgeVariants({ presentation: "connection-kind" }))).toBe(
      cn(badgeVariants(), "h-4 px-1.5 text-10px"),
    );
  });

  it("preserves the provider-email copy button's size and color overrides", () => {
    expect(
      cn(
        buttonVariants({ size: "icon-xs", variant: "ghost", presentation: "provider-email-copy" }),
      ),
    ).toBe(
      cn(
        buttonVariants({ size: "icon-xs", variant: "ghost" }),
        "size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground",
      ),
    );
  });
});
