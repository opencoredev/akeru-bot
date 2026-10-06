import type { GenerativeBlockSpec } from "./generativeSchemas";
import { GenerativeChart } from "./GenerativeChart";
import { GenerativeChoices } from "./GenerativeChoices";
import { GenerativeFlow } from "./GenerativeFlow";
import { GenerativeStats } from "./GenerativeStats";
import { GenerativeTasks } from "./GenerativeTasks";
import { GenerativeTimeline } from "./GenerativeTimeline";

export function GenerativeBlock({ block }: { readonly block: GenerativeBlockSpec }) {
  switch (block.kind) {
    case "chart":
      return <GenerativeChart spec={block.spec} />;
    case "stats":
      return <GenerativeStats spec={block.spec} />;
    case "tasks":
      return <GenerativeTasks spec={block.spec} />;
    case "flow":
      return <GenerativeFlow spec={block.spec} />;
    case "choices":
      return <GenerativeChoices spec={block.spec} />;
    case "timeline":
      return <GenerativeTimeline spec={block.spec} />;
  }
}
