import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as JPEG from "jpeg-js";
import { describe, expect, it } from "vite-plus/test";

const sourceFile = (path: string) =>
  NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, path), "utf8");

const jpegFrameMarker = (image: Buffer) => {
  let offset = 2;

  while (offset < image.byteLength) {
    while (image[offset] === 0xff) offset += 1;
    const marker = image[offset];
    offset += 1;

    if (marker >= 0xc0 && marker <= 0xc3) return marker;
    if (marker === 0xda || marker === undefined) break;

    const segmentLength = image.readUInt16BE(offset);
    offset += segmentLength;
  }

  return undefined;
};

describe("marketing search metadata", () => {
  it("keeps search metadata while preserving the original home page", () => {
    const home = sourceFile("pages/index.astro");

    expect(home).toContain('title="Akeru Bot | Open-source AI coding agent desktop app"');
    expect(home).toContain(
      'description="Run Claude, Codex, Grok, Kimi, and OpenCode coding agents',
    );
    expect(home).toContain('<h1 class="hero-title">Meet Akeru Bot</h1>');
    expect(home).toContain('<h2 class="section-title">Every bot has its own setup</h2>');
  });

  it("gives each Grok search intent one page", () => {
    const openSource = sourceFile("pages/open-source-grok-bot.astro");
    const comparison = sourceFile("pages/compare/akeru-vs-grok-bot.astro");
    const selfHosted = sourceFile("pages/guides/self-hosted-grok-bot.astro");

    expect(openSource).toContain('title="Open-source Grok Bot alternative | Akeru Bot"');
    expect(openSource).toContain('heading="An open-source alternative to Grok Bot"');
    expect(comparison).toContain('title="Akeru Bot vs Grok Bot | Open-source comparison"');
    expect(comparison).toContain('heading="Akeru Bot and Grok Bot compared"');
    expect(selfHosted).toContain('title="Self-hosted Grok Bot alternative | Akeru Bot"');
    expect(selfHosted).toContain('heading="Run a Grok bot on an environment you control"');
    expect(openSource).toContain('href="/compare/akeru-vs-grok-bot"');
    expect(comparison).toContain('href="/guides/self-hosted-grok-bot"');
    expect(selfHosted).toContain('href="/open-source-grok-bot"');
    expect(openSource).toContain('datePublished="2026-09-03"');
    expect(comparison).toContain('datePublished="2026-09-03"');
    expect(selfHosted).toContain('datePublished="2026-09-03"');
    expect(comparison).toMatch(
      /<td>Desktop clients<\/td>\s*<td>macOS, Windows, and Linux<\/td>\s*<td>macOS and Windows<\/td>/,
    );
  });

  it("publishes an editorial blog index that links every Grok article", () => {
    const blog = sourceFile("pages/blog/index.astro");
    const layout = sourceFile("layouts/Layout.astro");

    expect(blog).toContain('title="Akeru Blog | Open-source AI agent guides"');
    expect(blog).toContain("<h1>Blog</h1>");
    expect(blog).toContain('href: "/open-source-grok-bot"');
    expect(blog).toContain('href: "/compare/akeru-vs-grok-bot"');
    expect(blog).toContain('href: "/guides/self-hosted-grok-bot"');
    expect(blog).toContain('aria-label="Article topics"');
    expect(blog).toContain('<a class="topic-link" href={article.href}>{article.category}</a>');
    expect(blog).toContain('class="article-grid" id="articles"');
    expect(blog).not.toMatch(/Example|article-art/);
    expect(blog).toMatch(/\.blog-header \{[\s\S]*?text-align: center;/);
    expect(blog).not.toMatch(/gradient/);
    expect(layout).toContain('<a class="nav-link" href="/blog">Blog</a>');
  });

  it("uses one sans-serif face across the marketing site", () => {
    const layout = sourceFile("layouts/Layout.astro");
    const home = sourceFile("pages/index.astro");

    expect(layout).toContain("family=Geist:wght@400;500;600&family=EB+Garamond:wght@500");
    expect(layout).toContain('--font-serif: "EB Garamond", Georgia, serif;');
    expect(layout).toContain("--color-muted-foreground: #8a8a8a;");
    expect(home).not.toContain("--color-editorial-muted-foreground");
    expect(home).toContain("data-demo-video");
    expect(home).toMatch(/\.hero-title \{[\s\S]*?font-size: 84px;/);
    expect(home).toMatch(/background:[\s\S]*?url\("\/download-glow\.webp"\)/);
  });

  it("adds page and breadcrumb structured data to search pages", () => {
    const searchPage = sourceFile("components/SearchPage.astro");
    const layout = sourceFile("layouts/Layout.astro");

    expect(searchPage).toContain('"@type": "BreadcrumbList"');
    expect(searchPage).toContain('"@type": kind');
    expect(searchPage).toContain("mainEntityOfPage: canonicalUrl");
    expect(searchPage).toContain("datePublished");
    expect(searchPage).toContain("dateModified");
    expect(searchPage).toContain('name: "Blog"');
    expect(searchPage).toContain('name: "Akeru Bot"');
    expect(searchPage).toContain("articlePublishedTime={datePublished}");
    expect(searchPage).toContain("articleModifiedTime={dateModified}");
    expect(searchPage).toContain('class="article-layout"');
    expect(searchPage).toContain('href="/blog" aria-label="Back to blog"');
    expect(searchPage).toContain('<div class="related-grid">');
    expect(searchPage).not.toMatch(/gradient|blur\(/);
    expect(searchPage).toContain(
      "h1 { margin-top: 16px; font-size: 30px; line-height: 41px; letter-spacing: -0.5px; }",
    );
    expect(searchPage).toContain(
      ".article-copy :global(h2) { margin-top: 32px; font-size: 30px; line-height: 41px; }",
    );
    expect(searchPage).not.toMatch(/Akeru maintainers|readingTime|Share on|data-copy-url/);
    expect(searchPage).not.toMatch(/Example|article-cover|related-art/);
    expect(layout).toContain('Astro.url.pathname.replace(/\\/+$/, "")');
  });

  it("keeps wide comparison tables inside the mobile reading column", () => {
    const searchPage = sourceFile("components/SearchPage.astro");

    expect(searchPage).toMatch(/\.article-copy \{[\s\S]*?min-width: 0;/);
    expect(searchPage).toContain("overflow-x: auto;");
  });

  it("serves a crawler-compatible social card from a cache-busted URL", () => {
    const layout = sourceFile("layouts/Layout.astro");
    const socialImage = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../public/og-v2.jpg"),
    );
    const decoded = JPEG.decode(socialImage, { formatAsRGBA: false, useTArray: true });

    expect(layout).toContain('new URL("/og-v2.jpg", siteOrigin)');
    expect(layout).toContain('<meta property="og:image:type" content="image/jpeg" />');
    expect(layout).toContain('<meta property="og:image:width" content="1200" />');
    expect(layout).toContain('<meta property="og:image:height" content="630" />');
    expect(layout).toContain('<meta name="twitter:image:alt"');
    expect(jpegFrameMarker(socialImage)).toBe(0xc0);
    expect(decoded).toMatchObject({ width: 1200, height: 630 });
    expect(decoded.data.byteLength).toBe(1200 * 630 * 3);
    expect(socialImage.byteLength).toBeLessThan(5_000_000);
  });

  it("keeps missing pages out of search results", () => {
    const layout = sourceFile("layouts/Layout.astro");
    const notFound = sourceFile("pages/404.astro");

    expect(layout).toContain('<meta name="robots" content="noindex, follow" />');
    expect(layout).toContain("description: softwareDescription");
    expect(notFound).toMatch(/<Layout[\s\S]*?noindex/);
  });
});
