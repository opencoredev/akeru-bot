import { describe, expect, it, vi } from "vite-plus/test";

import {
  isHostedPairingLink,
  listenForPairingHash,
  takePairingHash,
  readHostedPairingLink,
  runHostedPairing,
} from "./hostedPairing";

const LINK =
  "https://tunnel.example.com/pair?host=https%3A%2F%2Fbox.tail.ts.net%3A3773&label=Box#token=abc";

describe("isHostedPairingLink", () => {
  it("matches /pair with a host, with or without its token", () => {
    expect(isHostedPairingLink(LINK)).toBe(true);
    expect(isHostedPairingLink("https://tunnel.example.com/pair?host=box.local")).toBe(true);
  });

  it("leaves direct pairing links and other pages to the primary environment", () => {
    expect(isHostedPairingLink("https://box.local:3773/pair#token=abc")).toBe(false);
    expect(isHostedPairingLink("https://box.local:3773/?host=other#token=abc")).toBe(false);
  });

  it("treats a link naming the page's own origin as ordinary pairing", () => {
    expect(
      isHostedPairingLink(
        "http://localhost:6563/pair?host=http%3A%2F%2Flocalhost%3A6563#token=abc",
      ),
    ).toBe(false);
    expect(
      isHostedPairingLink("http://localhost:6563/pair?host=ws%3A%2F%2Flocalhost%3A6563%2F"),
    ).toBe(false);
    expect(isHostedPairingLink("https://box.local/pair?host=box.local#token=abc")).toBe(false);
    expect(isHostedPairingLink("http://box.local:3773/pair?host=box.local:3773#token=abc")).toBe(
      false,
    );
    expect(
      isHostedPairingLink("http://box.local:3773/pair?host=https%3A%2F%2Fbox.local%3A3773"),
    ).toBe(true);
    expect(
      isHostedPairingLink(
        "http://localhost:6563/pair?host=http%3A%2F%2Flocalhost%3A3773#token=abc",
      ),
    ).toBe(true);
  });

  it("keeps a query token on a same-origin link on the hosted path, which refuses it", () => {
    const href = "http://localhost:6563/pair?host=http%3A%2F%2Flocalhost%3A6563&token=abc";
    expect(isHostedPairingLink(href)).toBe(true);
    expect(readHostedPairingLink(href)).toBeNull();
    expect(isHostedPairingLink("http://localhost:6563/pair?token=abc")).toBe(false);
  });
});

describe("listenForPairingHash", () => {
  it("submits a token that arrives by hash change, stripped first and once in flight", () => {
    const target = new EventTarget();
    let token: string | null = null;
    let busy = false;
    const calls: string[] = [];
    const stop = listenForPairingHash(target, {
      read: () => token,
      isBusy: () => busy,
      strip: () => calls.push("strip"),
      submit: (value) => {
        calls.push(`submit:${value}`);
        busy = true;
      },
    });

    target.dispatchEvent(new Event("hashchange"));
    expect(calls).toEqual([]);

    token = "abc";
    target.dispatchEvent(new Event("hashchange"));
    target.dispatchEvent(new Event("hashchange"));
    expect(calls).toEqual(["strip", "submit:abc"]);

    busy = false;
    stop();
    target.dispatchEvent(new Event("hashchange"));
    expect(calls).toEqual(["strip", "submit:abc"]);
  });
});

describe("takePairingHash", () => {
  it("leaves a link opened mid-submission for the next take", () => {
    let busy = true;
    const calls: string[] = [];
    const options = {
      read: () => "def",
      isBusy: () => busy,
      strip: () => calls.push("strip"),
      submit: (value: string) => calls.push(`submit:${value}`),
    };

    takePairingHash(options);
    expect(calls).toEqual([]);

    busy = false;
    takePairingHash(options);
    expect(calls).toEqual(["strip", "submit:def"]);
  });
});

describe("readHostedPairingLink", () => {
  it("reads the host, token, and label", () => {
    expect(readHostedPairingLink(LINK)).toEqual({
      host: "https://box.tail.ts.net:3773",
      token: "abc",
      label: "Box",
    });
  });

  it("returns null when the token is missing", () => {
    expect(readHostedPairingLink("https://tunnel.example.com/pair?host=box.local")).toBeNull();
  });

  it("refuses a token sent in the query string", () => {
    expect(
      readHostedPairingLink("https://tunnel.example.com/pair?host=box.local&token=abc"),
    ).toBeNull();
    expect(
      readHostedPairingLink("https://tunnel.example.com/pair?host=box.local&token=abc#token=def"),
    ).toBeNull();
  });
});

describe("runHostedPairing", () => {
  it("reports an incomplete link without connecting", async () => {
    const connect = vi.fn();
    await expect(runHostedPairing(null, connect)).resolves.toEqual({ kind: "incomplete" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("pairs with the link's host and token", async () => {
    const connect = vi.fn(async () => ({ ok: true as const }));
    await expect(runHostedPairing(readHostedPairingLink(LINK), connect)).resolves.toEqual({
      kind: "paired",
    });
    expect(connect).toHaveBeenCalledWith({
      host: "https://box.tail.ts.net:3773",
      pairingCode: "abc",
    });
  });

  it("surfaces the connection failure", async () => {
    const connect = vi.fn(async () => ({ ok: false as const, message: "Server unreachable." }));
    await expect(runHostedPairing(readHostedPairingLink(LINK), connect)).resolves.toEqual({
      kind: "failed",
      message: "Server unreachable.",
    });
  });
});
