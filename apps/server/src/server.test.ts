import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { HttpClient } from "effect/unstable/http";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { getHttpServerUrl, fetchEffect } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("parks HTTP ingress until command readiness", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-gate-" });
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "ready");
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();

      yield* buildAppUnderTest({
        config: { staticDir },
        layers: {
          serverRuntimeStartup: {
            awaitCommandReady: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(ready)),
            ),
          },
        },
      });

      const request = yield* HttpClient.get("/").pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      );

      yield* Deferred.await(entered);
      assert.isFalse(yield* Deferred.isDone(completed));

      yield* Deferred.succeed(ready, undefined);
      assert.equal((yield* Fiber.join(request)).status, 200);
      assert.isTrue(yield* Deferred.isDone(completed));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revalidates static files without sending unchanged bodies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-cache-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>first build</html>");
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/");
      assert.equal(initial.status, 200);
      assert.equal(initial.headers["cache-control"], "no-cache");
      assert.include(yield* initial.text, "first build");
      const etag = initial.headers.etag;
      assert.isDefined(etag);
      assert.isDefined(initial.headers["last-modified"]);

      for (const headers of [
        { "if-none-match": etag! },
        { "if-none-match": `"older", ${etag!.replace(/^W\//, "")}` },
        { "if-none-match": "*" },
      ]) {
        const response = yield* HttpClient.get("/", { headers });
        assert.equal(response.status, 304);
        assert.equal(response.headers.etag, etag);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(yield* response.text, "");
      }

      const dateOnly = yield* HttpClient.get("/", {
        headers: { "if-modified-since": initial.headers["last-modified"]! },
      });

      assert.equal(dateOnly.status, 200);
      assert.include(yield* dateOnly.text, "first build");

      const mismatched = yield* HttpClient.get("/", {
        headers: {
          "if-none-match": '"another-build"',
          "if-modified-since": initial.headers["last-modified"]!,
        },
      });

      assert.equal(mismatched.status, 200);
      assert.include(yield* mismatched.text, "first build");

      yield* fileSystem.writeFileString(indexPath, "<html>the next build is available</html>");
      const changed = yield* HttpClient.get("/", { headers: { "if-none-match": etag! } });
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.etag, etag);
      assert.include(yield* changed.text, "next build");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("changes mutable validators when equal-size content keeps its modification time", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-etag-" });
      const indexPath = path.join(staticDir, "index.html");
      const original = "<html>build one</html>";
      const replacement = "<html>build two</html>";
      assert.equal(original.length, replacement.length);
      yield* fileSystem.writeFileString(indexPath, original);
      const originalInfo = yield* fileSystem.stat(indexPath);
      const originalMtime = Option.getOrThrow(originalInfo.mtime);
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/");
      const initialEtag = initial.headers.etag;
      assert.equal(yield* initial.text, original);
      assert.isDefined(initialEtag);

      yield* fileSystem.writeFileString(indexPath, replacement);
      yield* fileSystem.utimes(indexPath, originalMtime, originalMtime);

      const changed = yield* HttpClient.get("/", {
        headers: { "if-none-match": initialEtag! },
      });

      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.etag, initialEtag);
      assert.equal(yield* changed.text, replacement);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("caches hashed static assets without freezing mutable files or SPA fallbacks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-hashes-" });
      yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
      yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
      yield* fileSystem.writeFileString(
        path.join(staticDir, ".vite", "manifest.json"),
        `{
          "index.html": { "file": "assets/index-AbCd0123.js", "isEntry": true },
          "large.js": { "file": "assets/large-aBcD9876.js" }
        }`,
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "<html>app</html>");
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "index-AbCd0123.js"),
        "export const app = true;",
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "assets", "config.json"), "{}");
      const largeAsset = "export const value = 123;\n".repeat(8192);
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "large-aBcD9876.js"),
        largeAsset,
      );
      yield* buildAppUnderTest({ config: { staticDir } });

      const asset = yield* HttpClient.get("/assets/index-AbCd0123.js");
      assert.equal(asset.status, 200);
      assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
      assert.equal(yield* asset.text, "export const app = true;");

      const head = yield* HttpClient.head("/assets/index-AbCd0123.js", {
        headers: { "accept-encoding": "identity" },
      });

      assert.equal(head.status, 200);
      assert.equal(head.headers.etag, asset.headers.etag);
      assert.equal(head.headers["content-length"], String("export const app = true;".length));
      assert.equal(yield* head.text, "");

      const compressed = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });

      assert.equal(compressed.headers["content-encoding"], "gzip");
      assert.equal(compressed.headers.vary, "Accept-Encoding");
      assert.equal(yield* compressed.text, largeAsset);

      const compressedHead = yield* HttpClient.head("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });

      assert.equal(compressedHead.status, 200);
      assert.equal(compressedHead.headers["content-encoding"], "gzip");
      assert.equal(compressedHead.headers.vary, "Accept-Encoding");
      assert.equal(compressedHead.headers.etag, compressed.headers.etag);
      assert.equal(compressedHead.headers["content-length"], compressed.headers["content-length"]);
      assert.equal(yield* compressedHead.text, "");

      const unchanged = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "identity", "if-none-match": compressed.headers.etag! },
      });

      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.headers.vary, "Accept-Encoding");
      assert.equal(yield* unchanged.text, "");

      for (const resource of [
        "/assets/config.json",
        "/threads/example",
        "/assets/old-ZyXw9876.js",
      ]) {
        const response = yield* HttpClient.get(resource);
        assert.equal(response.status, 200);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(
          yield* response.text,
          resource.endsWith("config.json") ? "{}" : "<html>app</html>",
        );
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const manifest of [
    { label: "missing", contents: null },
    { label: "nonmatching", contents: '{"other.js":{"file":"assets/other-AbCd0123.js"}}' },
    { label: "malformed", contents: "{not-json" },
  ]) {
    it.effect(`revalidates hash-like static filenames with a ${manifest.label} manifest`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const staticDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-static-mutable-",
        });

        yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));

        if (manifest.contents !== null) {
          yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
          yield* fileSystem.writeFileString(
            path.join(staticDir, ".vite", "manifest.json"),
            manifest.contents,
          );
        }

        const filePath = path.join(staticDir, "assets", "config-20260904.js");
        yield* fileSystem.writeFileString(filePath, "first config");
        yield* buildAppUnderTest({ config: { staticDir } });

        const initial = yield* HttpClient.get("/assets/config-20260904.js");
        assert.equal(initial.headers["cache-control"], "no-cache");
        assert.equal(yield* initial.text, "first config");

        yield* fileSystem.writeFileString(filePath, "replacement config");

        const changed = yield* HttpClient.get("/assets/config-20260904.js", {
          headers: { "if-none-match": initial.headers.etag! },
        });

        assert.equal(changed.status, 200);
        assert.equal(changed.headers["cache-control"], "no-cache");
        assert.notEqual(changed.headers.etag, initial.headers.etag);
        assert.equal(yield* changed.text, "replacement config");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("binds static metadata and bytes to one file across atomic replacement", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-replace-" });
      const beforeOpenPath = path.join(staticDir, "before-open.txt");
      const afterOpenPath = path.join(staticDir, "after-open.txt");
      const original = "original bytes";
      const replacement = "replacement bytes with a different size";

      for (const filePath of [beforeOpenPath, afterOpenPath]) {
        yield* fileSystem.writeFileString(filePath, original);
        yield* fileSystem.writeFileString(`${filePath}.next`, replacement);
      }

      const replaced = new Set<string>();

      const replaceOnce = Effect.fnUntraced(function* (filePath: string) {
        if (replaced.has(filePath)) return;
        replaced.add(filePath);
        yield* fileSystem.rename(`${filePath}.next`, filePath);
      });

      const replacingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        stat: (filePath) =>
          fileSystem
            .stat(filePath)
            .pipe(
              Effect.tap(() => (filePath === beforeOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
        open: (filePath, options) =>
          fileSystem
            .open(filePath, options)
            .pipe(
              Effect.tap(() => (filePath === afterOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
      });

      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, replacingFileSystem),
      );

      for (const [name, expected] of [
        ["before-open.txt", replacement],
        ["after-open.txt", original],
      ] as const) {
        const response = yield* HttpClient.get(`/${name}`, {
          headers: { "accept-encoding": "identity" },
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers["content-length"], String(expected.length));
        assert.isDefined(response.headers.etag);
        assert.equal(yield* response.text, expected);
        assert.isTrue(replaced.has(path.join(staticDir, name)));
        assert.equal(yield* fileSystem.readFileString(path.join(staticDir, name)), replacement);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes static file handles after GET, HEAD, 304, and request cancellation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-close-" });
      const filePath = path.join(staticDir, "index.html");
      const body = "<p>file content</p>".repeat(1024);
      yield* fileSystem.writeFileString(filePath, body);
      const closed = yield* Queue.unbounded<FileSystem.File>();
      const blocked = yield* Deferred.make<void>();
      const active = new Set<FileSystem.File>();
      let blockAfterOpen = false;
      let bodyReads = 0;

      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fileSystem.open(candidate, options);
            let opened: FileSystem.File | undefined;
            // Registered first, so this signal runs after the real descriptor-close finalizer.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (opened === undefined) return;
                active.delete(opened);
                yield* Queue.offer(closed, opened);
              }),
            );
            const file = yield* fileSystem.open(candidate, options);
            opened = file;
            active.add(file);

            if (blockAfterOpen) {
              yield* Deferred.succeed(blocked, undefined);

              return yield* Effect.never;
            }

            return new Proxy(file, {
              get(target, key) {
                if (key === "readAlloc") {
                  return (size: FileSystem.SizeInput) => {
                    bodyReads += 1;

                    return target.readAlloc(size);
                  };
                }

                return Predicate.hasProperty(target, key) ? target[key] : undefined;
              },
            });
          }),
      });

      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );

      const get = yield* HttpClient.get("/");
      assert.equal(yield* get.text, body);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.isAbove(bodyReads, 0);
      const readsAfterGet = bodyReads;

      const head = yield* HttpClient.head("/", { headers: { "accept-encoding": "gzip" } });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-encoding"], "gzip");
      assert.equal(yield* head.text, "");
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      const unchanged = yield* HttpClient.get("/", {
        headers: { "if-none-match": get.headers.etag! },
      });

      assert.equal(unchanged.status, 304);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      blockAfterOpen = true;
      const cancelled = yield* HttpClient.get("/").pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      assert.equal(active.size, 1);
      yield* Fiber.interrupt(cancelled);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
      const response = yield* fetchEffect(url, { redirect: "manual" });

      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "http://127.0.0.1:5173/foo/bar?token=test-token");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
