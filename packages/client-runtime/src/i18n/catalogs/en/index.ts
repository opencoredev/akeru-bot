import { rosterCatalog } from "./roster.ts";
import { connectionsCatalog } from "./connections.ts";
import { chatCatalog } from "./chat.ts";
import { settingsCatalog } from "./settings.ts";
import { memoryCatalog } from "./memory.ts";
import { commonCatalog } from "./common.ts";

export const englishCatalog = {
  ...rosterCatalog,
  ...connectionsCatalog,
  ...chatCatalog,
  ...settingsCatalog,
  ...memoryCatalog,
  ...commonCatalog,
} as const;
