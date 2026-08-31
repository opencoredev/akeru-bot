import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { GroupDetailsPanel } from "../components/roster/GroupDetailsPanel";
import { GroupThreadLanding } from "../components/roster/GroupThreadLanding";
import { useRosterStore } from "../components/roster/rosterStore";
import { authEnvironment } from "../state/auth";
import { environmentPeopleAtom } from "../state/bots";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";

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
  const currentPerson = useAtomValue(
    environmentPeopleAtom((environmentId ?? "") as EnvironmentId),
  ).current;
  const accessChanges = useEnvironmentQuery(
    environmentId === null ? null : authEnvironment.accessChanges({ environmentId, input: null }),
  );
  const people =
    accessChanges.data?.type === "snapshot" ? accessChanges.data.payload.clientSessions : [];

  return (
    <>
      <GroupThreadLanding groupId={groupId} />
      {environmentId && group ? (
        <GroupDetailsPanel
          key={group.id}
          environmentId={environmentId}
          group={group}
          bots={bots}
          people={people}
          currentPersonId={currentPerson?.id ?? null}
          onDeleted={() => void navigate({ to: "/" })}
        />
      ) : null}
    </>
  );
}

export const Route = createFileRoute("/_chat/groups/$groupId")({
  component: GroupThreadRouteView,
});
