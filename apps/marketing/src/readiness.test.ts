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
    expect(llms).toContain("https://www.akeru-bot.com/open-source-grok-bot");
    expect(llms).toContain("https://www.akeru-bot.com/blog");
    expect(llms).toContain("https://www.akeru-bot.com/compare/akeru-vs-grok-bot");
    expect(llms).toContain("https://www.akeru-bot.com/guides/self-hosted-grok-bot");
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

  it("does not advertise a public API", () => {
    const routes = routesWithHeaders();

    expect(routes.some((route) => "RateLimit" in route.headers)).toBe(false);
    expect(JSON.stringify(routes)).not.toContain("openapi");
    expect(NodeFS.existsSync(NodePath.resolve(import.meta.dirname, "../public/openapi.json"))).toBe(
      false,
    );
  });

  it("publishes a current sitemap with the trust pages", () => {
    const sitemap = publicFile("sitemap.xml");

    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/about</loc>");
    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/contact</loc>");
    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/blog</loc>");
    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/open-source-grok-bot</loc>");
    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/compare/akeru-vs-grok-bot</loc>");
    expect(sitemap).toContain("<loc>https://www.akeru-bot.com/guides/self-hosted-grok-bot</loc>");
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

  it("answers unknown API paths with a problem document", () => {
    const apiError = JSON.parse(publicFile("api-error.json"));

    expect(apiError).toMatchObject({ status: 404, code: "api_resource_not_found" });
    expect(apiError.resolution).toContain("https://www.akeru-bot.com/developers");
  });
});
