import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/unstable/socket/Socket";
import * as ExpoCrypto from "expo-crypto";

import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

import * as Persistence from "../persistence/layer";

function toExpoDigestAlgorithm(
  algorithm: Crypto.DigestAlgorithm,
): ExpoCrypto.CryptoDigestAlgorithm {
  switch (algorithm) {
    case "SHA-1":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA1;
    case "SHA-256":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA256;
    case "SHA-384":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA384;
    case "SHA-512":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA512;
  }
}

const httpClientLayer = remoteHttpClientLayer(fetch);
const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: ExpoCrypto.getRandomBytes,
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await ExpoCrypto.digest(toExpoDigestAlgorithm(algorithm), input));
      }),
  }),
);

type RuntimeLayerSource =
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof cryptoLayer
  | typeof httpClientLayer
  | typeof Persistence.layer;

const runtimeLayer = Layer.mergeAll(
  Socket.layerWebSocketConstructorGlobal,
  cryptoLayer,
  httpClientLayer,
  Persistence.layer,
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);
