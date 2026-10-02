import { type ChannelBinding } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelDetailPage } from "./ChannelDetailPage";

export const fixtureConnection = {
  id: "profile-1",
  name: "Fixture line",
  provider: "imessage",
  externalIdentity: null,
};

export function boundBot(
  status: ChannelBinding["status"],
  lastError?: string,
  failureCategory?: ChannelBinding["failureCategory"],
  provider: "imessage" | "whatsapp" = "imessage",
) {
  return {
    id: "bot-uuid",
    name: "Akeru",
    archivedAt: null,
    channelBindings: [
      {
        botId: "bot-uuid",
        connectionId: "profile-1",
        provider,
        projectId: "project-uuid",
        status,
        ...(lastError ? { lastError } : {}),
        ...(failureCategory ? { failureCategory } : {}),
        externalIdentity: null,
        connectedAt: null,
        sentMessageIds: [],
      },
    ],
  };
}

export function trigger(html: string, label: string) {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

export function button(html: string, label: string) {
  return html.match(new RegExp(`<(?:button|a)[^>]*>${label}</(?:button|a)>`))?.[0];
}

export const renderPage = (provider: "imessage" | "whatsapp" = "imessage") =>
  renderToStaticMarkup(<ChannelDetailPage provider={provider} />);
