import { Clock, Effect } from "effect";
import { ComputerError, type ComputerAction, type ComputerFrame } from "@t3tools/contracts";
import type { BotBrowserRpc } from "./botBrowser.ts";
import type { AkeruBrowserEndpoint, AkeruWorkspaceState } from "./botWorkspace.ts";
import { ComputerGate } from "./computerGate.ts";
import { ComputerCdp } from "./computerCdp.ts";

export interface ComputerDesktop {
  open(): Promise<void>;
  input(action: ComputerAction): Promise<void>;
  capture(): Promise<ComputerFrame>;
}

/** Shared by the bot browser and human transport for one native workspace identity. */
export class WorkspaceComputer implements BotBrowserRpc {
  readonly gate: ComputerGate;
  private initialization: Promise<void> | undefined;
  private browser: ComputerCdp | undefined;
  readonly workspaceId: string;
  readonly desktop: ComputerDesktop;
  private readonly launch: () => Promise<void>;
  private readonly endpoint: () => Promise<AkeruBrowserEndpoint>;
  private readonly inspect: () => Promise<AkeruWorkspaceState>;
  constructor(
    workspaceId: string,
    desktop: ComputerDesktop,
    launch: () => Promise<void>,
    endpoint: () => Promise<AkeruBrowserEndpoint>,
    inspect: () => Promise<AkeruWorkspaceState>,
    clock: Clock.Clock = Effect.runSync(Clock.Clock),
  ) {
    this.gate = new ComputerGate(clock);
    this.workspaceId = workspaceId;
    this.desktop = desktop;
    this.launch = launch;
    this.endpoint = endpoint;
    this.inspect = inspect;
  }

  private async checkRunning() {
    if ((await this.inspect()) !== "running") {
      this.gate.stop();
      throw new ComputerError({ code: "closed", message: "Computer workspace is not running." });
    }
  }

  private async connect() {
    await this.checkRunning();
    if (this.browser?.connected) return this.browser;
    this.browser?.close();
    this.browser = undefined;
    await this.initialize();
    this.browser = await ComputerCdp.connect(await this.endpoint());
    return this.browser;
  }

  private initialize() {
    if (this.initialization) return this.initialization;
    const generation = this.gate.generation;
    this.initialization = (async () => {
      await this.checkRunning();
      await this.desktop.open();
      await this.launch();
      if (generation !== this.gate.generation) {
        throw new ComputerError({
          code: "revoked",
          message: "Computer initialization was revoked.",
        });
      }
    })().catch((cause: unknown) => {
      this.initialization = undefined;
      this.gate.stop();
      throw cause;
    });
    return this.initialization;
  }

  async open() {
    await this.gate.open();
    await this.initialize();
  }

  async call(name: string, input: Readonly<Record<string, unknown>>): Promise<string> {
    return this.gate.bot(async () => (await this.connect()).call(name, input));
  }

  async input(action: ComputerAction) {
    const generation = this.gate.generation;
    await this.checkRunning();
    await this.initialize();
    // Release or stop during inspection must not let a stale action reach the desktop.
    if (generation !== this.gate.generation) {
      throw new ComputerError({ code: "revoked", message: "Computer input was revoked." });
    }
    await this.desktop.input(action);
  }

  async capture() {
    await this.checkRunning();
    if (this.gate.status !== "ready" && this.gate.status !== "human") {
      throw new ComputerError({ code: "closed", message: "Computer is stopped." });
    }
    await this.initialize();
    if (this.gate.status !== "ready" && this.gate.status !== "human") {
      throw new ComputerError({ code: "closed", message: "Computer is stopped." });
    }
    const generation = this.gate.generation;
    const frame = await this.desktop.capture();
    await this.checkRunning();
    if (
      generation !== this.gate.generation ||
      (this.gate.status !== "ready" && this.gate.status !== "human")
    ) {
      throw new ComputerError({ code: "revoked", message: "Computer frame was invalidated." });
    }
    return frame;
  }

  async attachment() {
    return undefined;
  }
  async reconnect() {
    await this.close();
  }
  async close() {
    this.gate.stop();
    this.browser?.close();
    this.browser = undefined;
    await this.initialization?.catch(() => undefined);
    this.initialization = undefined;
  }
}
