// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedChunks?: number;
}

export class RotatingFileSinkConfigurationError extends Schema.TaggedErrorClass<RotatingFileSinkConfigurationError>()(
  "RotatingFileSinkConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles", "maxBufferedBytes", "maxBufferedChunks"]),
    received: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be >= ${this.minimum} (received ${this.received})`;
  }
}

export class RotatingFileSinkError extends Schema.TaggedErrorClass<RotatingFileSinkError>()(
  "RotatingFileSinkError",
  {
    operation: Schema.Literals([
      "initialize",
      "read",
      "write",
      "rotate",
      "prune",
      "buffer",
      "closed",
    ]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`;
  }
}

const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);
const isFileNotFoundError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

interface PendingChunk {
  readonly buffer: Buffer;
  readonly resolve: () => void;
  readonly reject: (error: RotatingFileSinkError) => void;
}

const MAX_APPEND_BATCH_BYTES = 64 * 1024;

/** One owner serializes initialization, appends and rotation. Flush acknowledges accepted writes, not fsync. */
export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxBufferedBytes: number;
  private readonly maxBufferedChunks: number;
  private currentSize = 0;
  private pendingBytes = 0;
  private pendingChunks = 0;
  private closed = false;
  private failure: RotatingFileSinkError | undefined;
  private fatalFailure: RotatingFileSinkError | undefined;
  private readonly initialized: Promise<void>;
  private latestWrite: Promise<void> | undefined;
  private readonly queue: PendingChunk[] = [];
  private draining = false;

  constructor(options: RotatingFileSinkOptions) {
    const limits = {
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      maxBufferedBytes: options.maxBufferedBytes ?? 1024 * 1024,
      maxBufferedChunks: options.maxBufferedChunks ?? 512,
    };
    for (const [option, received] of Object.entries(limits)) {
      if (!Number.isSafeInteger(received) || received < 1) {
        throw new RotatingFileSinkConfigurationError({
          option: option as keyof typeof limits,
          received,
          minimum: 1,
        });
      }
    }
    this.filePath = options.filePath;
    this.maxBytes = limits.maxBytes;
    this.maxFiles = limits.maxFiles;
    this.maxBufferedBytes = limits.maxBufferedBytes;
    this.maxBufferedChunks = limits.maxBufferedChunks;
    this.initialized = this.initialize().catch((cause: RotatingFileSinkError) => {
      this.failure = cause;
      this.fatalFailure = cause;
    });
  }

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  get bufferedChunks(): number {
    return this.pendingChunks;
  }

  write(chunk: string | Buffer): Promise<void> {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (this.closed) {
      return Promise.reject(this.error("closed", new Error("Log sink is closed")));
    }
    if (bytes === 0) return Promise.resolve();
    if (
      this.pendingBytes + bytes > this.maxBufferedBytes ||
      this.pendingChunks >= this.maxBufferedChunks
    ) {
      const error = this.error("buffer", new Error("Log buffer capacity exceeded"));
      this.failure ??= error;
      return Promise.reject(error);
    }

    // Copy caller-owned buffers so queued bytes cannot change before the append.
    const buffer = Buffer.from(chunk);
    this.pendingBytes += bytes;
    this.pendingChunks += 1;
    const receipt = Promise.withResolvers<void>();
    this.queue.push({ buffer, resolve: () => receipt.resolve(), reject: receipt.reject });
    this.latestWrite = receipt.promise;
    void receipt.promise.catch(() => undefined);
    if (!this.draining) {
      this.draining = true;
      void this.drain();
    }
    return receipt.promise;
  }

  async flush(): Promise<void> {
    await (this.latestWrite ?? this.initialized).catch(() => undefined);
    if (this.failure) throw this.failure;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }

  private async drain(): Promise<void> {
    let active: PendingChunk[] = [];
    try {
      await this.initialized;
      while (this.queue.length > 0) {
        if (this.fatalFailure) throw this.fatalFailure;
        const first = this.queue[0]!;
        if (this.currentSize > 0 && this.currentSize + first.buffer.length > this.maxBytes) {
          await this.rotate();
        }
        let bytes = first.buffer.length;
        let count = 1;
        while (count < this.queue.length) {
          const nextBytes = this.queue[count]!.buffer.length;
          if (
            bytes + nextBytes > MAX_APPEND_BATCH_BYTES ||
            this.currentSize + bytes + nextBytes > this.maxBytes
          )
            break;
          bytes += nextBytes;
          count += 1;
        }
        active = this.queue.splice(0, count);
        await NodeFSP.appendFile(
          this.filePath,
          count === 1
            ? first.buffer
            : Buffer.concat(
                active.map((entry) => entry.buffer),
                bytes,
              ),
        );
        this.currentSize += bytes;
        for (const entry of active) {
          this.pendingBytes -= entry.buffer.length;
          this.pendingChunks -= 1;
          entry.resolve();
        }
        active = [];
      }
    } catch (cause) {
      const error = isRotatingFileSinkError(cause) ? cause : this.error("write", cause);
      // An append may have partially succeeded; never retry ambiguous bytes.
      this.failure ??= error;
      this.fatalFailure = error;
      for (const entry of [...active, ...this.queue.splice(0)]) entry.reject(error);
      this.pendingBytes = this.pendingChunks = 0;
    } finally {
      this.draining = false;
    }
  }

  private error(
    operation: RotatingFileSinkError["operation"],
    cause: unknown,
  ): RotatingFileSinkError {
    return new RotatingFileSinkError({ operation, filePath: this.filePath, cause });
  }

  private async initialize(): Promise<void> {
    try {
      await NodeFSP.mkdir(NodePath.dirname(this.filePath), { recursive: true });
    } catch (cause) {
      throw this.error("initialize", cause);
    }
    try {
      const dir = NodePath.dirname(this.filePath);
      const baseName = NodePath.basename(this.filePath);
      for (const entry of await NodeFSP.readdir(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        await NodeFSP.rm(NodePath.join(dir, entry), { force: true });
      }
    } catch (cause) {
      throw this.error("prune", cause);
    }
    try {
      this.currentSize = (await NodeFSP.stat(this.filePath)).size;
    } catch (cause) {
      if (!isFileNotFoundError(cause)) throw this.error("read", cause);
    }
  }

  private async rotate(): Promise<void> {
    try {
      await NodeFSP.rm(`${this.filePath}.${this.maxFiles}`, { force: true });
      for (let index = this.maxFiles - 1; index >= 0; index -= 1) {
        const source = index === 0 ? this.filePath : `${this.filePath}.${index}`;
        try {
          await NodeFSP.rename(source, `${this.filePath}.${index + 1}`);
        } catch (cause) {
          if (!isFileNotFoundError(cause)) throw cause;
        }
      }
      this.currentSize = 0;
    } catch (cause) {
      throw this.error("rotate", cause);
    }
  }
}
