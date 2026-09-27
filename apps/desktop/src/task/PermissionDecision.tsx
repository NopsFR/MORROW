import type { PermissionRequest, PermissionScope } from "@morrow/schemas";
import { riskRank } from "@morrow/schemas";
import { MAX_RISK_FOR_SCOPE } from "@morrow/permissions";
import { Button, KeyValue, Label, Mono, StateMark } from "@morrow/ui";
import { RISK_TONE } from "../views/format";

export type RespondFn = (requestId: PermissionRequest["id"], decision: "ALLOW" | "DENY", scope: PermissionScope) => void;

const SCOPE_TEXT: Record<PermissionScope, string> = {
  ONE_TIME: "this operation only",
  TASK: "this capability for the rest of this task",
  PROJECT: "this capability within this project",
  TOOL: "this capability for this tool, everywhere",
  GLOBAL: "this capability everywhere",
};

/**
 * Which scopes may be offered for a request. Mirrors the permission engine's risk
 * ceilings; the runtime enforces them regardless of what the UI offers.
 */
export function allowedScopes(request: PermissionRequest): PermissionScope[] {
  const scopes: PermissionScope[] = ["ONE_TIME"];
  if (request.taskId) scopes.push("TASK");
  if (request.projectId) scopes.push("PROJECT");
  return scopes.filter((s) => riskRank(request.riskLevel) <= riskRank(MAX_RISK_FOR_SCOPE[s]));
}

/** A requested operation awaiting the user, shown in place within the task. */
export function PermissionDecision({ request, onRespond }: { request: PermissionRequest; onRespond: RespondFn }) {
  const scopes = allowedScopes(request);
  return (
    <article className="tv-decision tv-decision--permission" aria-label="Permission request">
      <div className="tv-decision__head">
        <Label tone="accent">Permission required</Label>
        <StateMark tone={RISK_TONE[request.riskLevel]} label={`${request.riskLevel} risk`} />
      </div>
      <p className="tv-decision__operation">{request.reason}</p>
      <KeyValue
        rows={[
          ["Capability", <Mono>{request.capability}</Mono>],
          ["Tool", <Mono>{request.toolId}</Mono>],
          ["Resource", request.resource ? <Mono>{request.resource}</Mono> : <span className="tv-muted">None</span>],
        ]}
      />
      <div className="tv-decision__actions">
        {scopes.map((scope) => (
          <Button
            key={scope}
            variant={scope === "ONE_TIME" ? "primary" : "quiet"}
            title={`Allow ${SCOPE_TEXT[scope]}`}
            onClick={() => onRespond(request.id, "ALLOW", scope)}
          >
            {scope === "ONE_TIME" ? "Allow once" : scope === "TASK" ? "Allow for this task" : "Allow for this project"}
          </Button>
        ))}
        <Button variant="danger" title="Deny this operation only" onClick={() => onRespond(request.id, "DENY", "ONE_TIME")}>
          Deny
        </Button>
        {request.taskId ? (
          <Button
            variant="danger"
            title="Deny this capability for the rest of this task"
            onClick={() => onRespond(request.id, "DENY", "TASK")}
          >
            Deny for this task
          </Button>
        ) : null}
      </div>
      {scopes.length === 1 && request.taskId ? (
        <p className="tv-muted">{request.riskLevel} risk operations can only be allowed one at a time.</p>
      ) : null}
    </article>
  );
}
