import { commonLabelsCatalog } from "./common-labels.ts";
import { commonMessagesCatalog } from "./common-messages.ts";

export const commonCatalog = { ...commonLabelsCatalog, ...commonMessagesCatalog } as const;
