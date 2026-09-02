import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { config } from "../vercel.ts";

const publicFile = (path: string) =>
  NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../public", path), "utf8");

const routesWithHeaders = () =>
  config.routes?.flatMap((route) =>
    "src" in route && route.headers !== undefined
      ? [{ src: route.src, headers: route.headers }]
      : [],
  ) ?? [];

describe("agent readiness files", () => {
  it("publishes agent guidance and crawler policy", () => {
    const llms = publicFile("llms.txt");
    const robots = publicFile("robots.txt");

    expect(llms).toMatch(/^# Akeru Bot/m);
    expect(llms).toContain("## When to use Akeru Bot");
    expect(robots).toContain("User-agent: GPTBot\nAllow: /");
    expect(robots).toContain("User-agent: CCBot\nDisallow: /");
    expect(robots).toContain("https://www.akeru-bot.com/sitemap.xml");
  });

  it("publishes feedback channels and links them from the agent guide", () => {
    const feedback = publicFile("feedback.md");
    const llms = publicFile("llms.txt");

    expect(feedback).toContain("## Where to send it");
    expect(feedback).toContain("https://github.com/opencoredev/akeru-bot/issues");
    expect(llms).toContain("https://www.akeru-bot.com/feedback.md");
    expect(routesWithHeaders()).toEqual(
      expect.arrayContaining([
        {
          src: "^/feedback\\.md$",
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        },
      ]),
    );
  });

  it("serves rate-limit headers on the metadata API paths", () => {
    const limited = routesWithHeaders().filter((route) => "RateLimit" in route.headers);

    expect(limited.map((route) => route.src)).toEqual([
      "^/(?:v\\d+/)?(?:schema/.*|openapi\\.json)$",
      "^/api(?:/.*)?$",
    ]);
    for (const route of limited) {
      expect(route.headers).toMatchObject({
        "RateLimit-Policy": '"default";q=600;w=60',
        RateLimit: '"default";r=600;t=60',
      });
    }
  });

  it("publishes a current sitemap with the trust pages", () => {
    const sitemap = publicFile("sitemap.xml");

    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/about</loc>");
    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/contact</loc>");
    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/privacy-policy</loc>");
    expect(sitemap).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  it("publishes valid discovery documents", () => {
    const ard = JSON.parse(publicFile(".well-known/ard.json"));

    expect(ard).toMatchObject({ specVersion: "1.0" });
    expect(ard.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identifier: "urn:air:akeru-bot.com:website" }),
      ]),
    );
  });

  it("documents the public metadata endpoint", () => {
    const openapi = JSON.parse(publicFile("openapi.json"));
    const apiError = JSON.parse(publicFile("api-error.json"));

    expect(openapi).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Akeru Bot public metadata API" },
    });
    const versioned = openapi.paths["/v1/schema/t3.json"].get;

    expect(versioned).toMatchObject({
      operationId: "getProjectFileSchema",
      responses: {
        "200": {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ProjectFileSchema" } },
          },
        },
        "429": { $ref: "#/components/responses/TooManyRequests" },
      },
    });
    expect(openapi.paths["/schema/t3.json"].get.operationId).toBe("getProjectFileSchemaAlias");
    expect(openapi.info.description).toContain("Sunset");
    expect(openapi.components.schemas.ProjectFileSchema).toMatchObject({ type: "object" });
    expect(apiError).toMatchObject({ status: 404, code: "api_resource_not_found" });
  });
});
