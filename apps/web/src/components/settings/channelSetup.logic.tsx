import { BotId, ChannelConnectionId, type ChannelProvider, type ProjectId } from "@akeru/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export const CONNECT_LATER = "connect-later";

const PHOTON_MODE_LABELS = {
  hosted: "Photon hosted",
  "self-hosted": "Photon self-hosted",
} as const;

/**
 * An assigned connection whose credentials the dialog replaces. The dialog saves the new
 * credentials as a new connection and only removes the old one after the bot connects, so a bad
 * token never takes a working channel down.
 */
export interface ChannelReplacement {
  readonly connectionId: ChannelConnectionId;
  readonly name: string;
  readonly botId: BotId;
  readonly projectId: ProjectId | undefined;
  /** The old binding was disconnected; restoring it after a failure keeps it disconnected. */
  readonly disconnected?: boolean;
}

/** The Photon connection type picker. The trigger shows the option label, not the raw mode. */
export function PhotonModeSelect({
  mode,
  onChange,
}: {
  readonly mode: keyof typeof PHOTON_MODE_LABELS;
  readonly onChange: (mode: keyof typeof PHOTON_MODE_LABELS) => void;
}) {
  return (
    <Select value={mode} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger aria-label="Photon connection type">
        <SelectValue>{PHOTON_MODE_LABELS[mode]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="hosted">{PHOTON_MODE_LABELS.hosted}</SelectItem>
        <SelectItem value="self-hosted">{PHOTON_MODE_LABELS["self-hosted"]}</SelectItem>
      </SelectPopup>
    </Select>
  );
}

export const newConnectionId = () =>
  ChannelConnectionId.make(`channel-${[...crypto.getRandomValues(new Uint32Array(4))].join("-")}`);

export function buildChannelConnectionSaveInput(input: {
  readonly connectionId: ChannelConnectionId;
  readonly name: string;
  readonly provider: ChannelProvider;
  readonly mode: "hosted" | "self-hosted";
  readonly values: Record<string, string>;
}) {
  const { connectionId, name, provider, mode, values } = input;
  const value = (key: string) => (values[key] ?? "").trim();

  if (provider === "telegram") return { connectionId, name, provider, token: value("token") };

  if (provider === "whatsapp") {
    return {
      connectionId,
      name,
      provider,
      accessToken: value("accessToken"),
      appSecret: value("appSecret"),
      phoneNumberId: value("phoneNumberId"),
      verifyToken: value("verifyToken"),
    };
  }

  if (provider === "slack") {
    return {
      connectionId,
      name,
      provider,
      botToken: value("botToken"),
      appToken: value("appToken"),
    };
  }

  if (provider === "discord") {
    return {
      connectionId,
      name,
      provider,
      applicationId: value("applicationId"),
      publicKey: value("publicKey"),
      botToken: value("botToken"),
    };
  }

  return mode === "hosted"
    ? {
        connectionId,
        name,
        provider,
        mode,
        projectId: value("projectId"),
        projectSecret: value("projectSecret"),
      }
    : {
        connectionId,
        name,
        provider,
        mode,
        serverUrl: value("serverUrl"),
        apiKey: value("apiKey"),
        ...(value("phone") ? { phone: value("phone") } : {}),
      };
}
