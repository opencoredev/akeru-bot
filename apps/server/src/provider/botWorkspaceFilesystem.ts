// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodePath from "node:path";

import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  ListOptions,
  ReadOptions,
  RemoveOptions,
  ProviderStatus,
  WorkspaceFilesystem,
  WriteOptions,
} from "@mastra/core/workspace";

interface RemoteCommandSession {
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export class BotWorkspaceFilesystem implements WorkspaceFilesystem {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly status: ProviderStatus = "ready";
  private readonly session: RemoteCommandSession;

  constructor(id: string, provider: string, session: RemoteCommandSession) {
    this.id = `${id}-filesystem`;
    this.name = `Akeru ${provider}`;
    this.provider = provider;
    this.session = session;
  }

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const result = await this.shell(`base64 < ${quote(path)}`);
    const content = Buffer.from(result.trim(), "base64");
    return options?.encoding ? content.toString(options.encoding) : content;
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    const checks = [
      options?.recursive ? `mkdir -p -- ${quote(NodePath.posix.dirname(path))}` : "",
      options?.overwrite === false ? `test ! -e ${quote(path)}` : "",
      options?.expectedMtime
        ? `test "$(stat -c %Y -- ${quote(path)})" = ${quote(String(Math.floor(options.expectedMtime.getTime() / 1_000)))}`
        : "",
      `printf %s ${quote(Buffer.from(content).toString("base64"))} | base64 -d > ${quote(path)}`,
    ].filter(Boolean);
    await this.shell(checks.join(" && "));
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    await this.shell(
      `printf %s ${quote(Buffer.from(content).toString("base64"))} | base64 -d >> ${quote(path)}`,
    );
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    await this.command("rm", [options?.force ? "-f" : "", "--", path].filter(Boolean));
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.command(
      "cp",
      [
        options?.recursive ? "-R" : "",
        options?.overwrite === false ? "-n" : "",
        "--",
        src,
        dest,
      ].filter(Boolean),
    );
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.command(
      "mv",
      [options?.overwrite === false ? "-n" : "", "--", src, dest].filter(Boolean),
    );
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.command("mkdir", [options?.recursive ? "-p" : "", "--", path].filter(Boolean));
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    await this.command(
      "rm",
      [options?.recursive ? "-R" : "-d", options?.force ? "-f" : "", "--", path].filter(Boolean),
    );
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    const maxDepth = options?.recursive ? options.maxDepth : 1;
    const output = await this.command("find", [
      path,
      "-mindepth",
      "1",
      ...(maxDepth === undefined ? [] : ["-maxdepth", String(maxDepth)]),
      "-printf",
      "%P\\037%y\\037%s\\037%l\\036",
    ]);
    const extensions = options?.extension
      ? Array.isArray(options.extension)
        ? options.extension
        : [options.extension]
      : undefined;
    return output
      .split("\u001e")
      .filter(Boolean)
      .map((record) => {
        const [name = "", type = "f", size = "0", symlinkTarget = ""] = record.split("\u001f");
        return {
          name,
          type: type === "d" ? ("directory" as const) : ("file" as const),
          ...(type === "d" ? {} : { size: Number(size) }),
          ...(type === "l" ? { isSymlink: true, symlinkTarget } : {}),
        };
      })
      .filter(
        (entry) => !extensions || extensions.some((extension) => entry.name.endsWith(extension)),
      );
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.session.run("test", ["-e", path]);
    return result.exitCode === 0;
  }

  async stat(path: string): Promise<FileStat> {
    const output = await this.command("stat", ["-c", "%F\\037%s\\037%W\\037%Y", "--", path]);
    const [kind = "", size = "0", createdAt = "0", modifiedAt = "0"] = output
      .trim()
      .split("\u001f");
    return {
      name: NodePath.posix.basename(path),
      path,
      type: kind.includes("directory") ? "directory" : "file",
      size: kind.includes("directory") ? 0 : Number(size),
      createdAt: new Date(Math.max(0, Number(createdAt)) * 1_000),
      modifiedAt: new Date(Number(modifiedAt) * 1_000),
    };
  }

  private async shell(script: string): Promise<string> {
    return this.command("sh", ["-lc", script]);
  }

  private async command(command: string, args: readonly string[]): Promise<string> {
    const result = await this.session.run(command, args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `${command} exited with code ${result.exitCode}.`);
    }
    return result.stdout;
  }
}
