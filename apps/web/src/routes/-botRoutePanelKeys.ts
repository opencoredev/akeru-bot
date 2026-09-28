export function botRoutePanelKeys(botId: string) {
  return {
    thread: `thread:${botId}`,
    details: `details:${botId}`,
  } as const;
}
