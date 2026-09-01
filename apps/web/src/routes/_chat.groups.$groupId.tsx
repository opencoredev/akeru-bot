import { createFileRoute } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { GroupDetailsPanel } from "../components/roster/GroupDetailsPanel";
import { GroupThreadLanding } from "../components/roster/GroupThreadLanding";
import { useRosterStore } from "../components/roster/rosterStore";
import { usePrimaryEnvironmentId } from "../state/environments";

function GroupThreadRouteView() {
  const { groupId } = Route.useParams();
  const navigate = Route.useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const { group, bots } = useRosterStore(
    useShallow((state) => ({
      group: state.groups.find((candidate) => candidate.id === groupId) ?? null,
      bots: state.bots,
    })),
  );
  return (
    <>
      <GroupThreadLanding groupId={groupId} />
      {environmentId && group ? (
        <GroupDetailsPanel
          key={group.id}
          environmentId={environmentId}
          group={group}
          bots={bots}
          onDeleted={() => void navigate({ to: "/" })}
        />
      ) : null}
    </>
  );
}

export const Route = createFileRoute("/_chat/groups/$groupId")({
  component: GroupThreadRouteView,
});
