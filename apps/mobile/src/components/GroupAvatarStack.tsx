import type { OrchestrationBot } from "@t3tools/contracts";
import { View } from "react-native";

import { BotAvatarView, seededBlobAvatar } from "./BotAvatarView";

/**
 * Overlapping two-bot avatar for group chats, matching the web roster's
 * GroupMemberStack: first member top-left, second offset bottom-right.
 * Without members the group falls back to a single seeded blob.
 */
export function GroupAvatarStack(props: {
  readonly bots: ReadonlyArray<OrchestrationBot>;
  readonly seed: string;
  /** Outer box edge in px; each member avatar is ~68% of it. */
  readonly size: number;
  readonly state?: "idle" | "working" | "needs-you";
}) {
  const members = props.bots.slice(0, 2);
  const avatarSize = Math.round(props.size * 0.68);
  if (members.length === 0) {
    return (
      <View style={{ height: props.size, width: props.size }}>
        <BotAvatarView
          avatar={seededBlobAvatar(props.seed)}
          size={props.size}
          state={props.state}
        />
      </View>
    );
  }
  return (
    <View style={{ height: props.size, width: props.size }}>
      {members.map((bot, index) => (
        <View
          key={bot.id}
          style={{
            position: "absolute",
            ...(index === 0 ? { left: 0, top: 0 } : { bottom: 0, right: 0, zIndex: 10 }),
          }}
        >
          <BotAvatarView
            avatar={bot.avatar ?? seededBlobAvatar(bot.id)}
            size={avatarSize}
            state={props.state}
          />
        </View>
      ))}
    </View>
  );
}
