import type { PermissionRequest, PermissionScope } from "@morrow/schemas";
import { riskRank } from "@morrow/schemas";
import { MAX_RISK_FOR_SCOPE } from "@morrow/permissions";
import { Button, KeyValue, Label, Mono, StateMark } from "@morrow/ui";
import { RISK_TONE } from "../views/format";

export type RespondFn = (requestId: PermissionRequest["id"], decision: "ALLOW" | "DENY", scope: PermissionScope) => void;

/** Task context for a request, when it is shown inside its task. */
export interface RequestContext {
  /** What the agent said the call is for. */
  readonly purpose: string | null;
  /** e.g. "step 1 of 2: Read package.json". */
  readonly step: string | null;
  readonly projectName: string | null;
}

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

const ALLOW_LABEL: Record<PermissionScope, string> = {
  ONE_TIME: "Allow once",
  TASK: "Allow for this task",
  PROJECT: "Allow for this project",
  TOOL: "Allow for this tool",
  GLOBAL: "Allow everywhere",
};

/** What each choice would cover, stated in terms of this request. */
export function scopeDescriptions(request: PermissionRequest, projectName: string | null): { label: string; covers: string }[] {
  const cap = request.capability;
  const covers: Record<PermissionScope, string> = {
    ONE_TIME: "only this operation; MORROW asks again next time",
    TASK: `${cap} for the rest of this task, at up to ${MAX_RISK_FOR_SCOPE.TASK} risk`,
    PROJECT: `${cap} for any task in ${projectName ? `project “${projectName}”` : "this project"}, at up to ${MAX_RISK_FOR_SCOPE.PROJECT} risk`,
    TOOL: `${cap} for ${request.toolId} everywhere`,
    GLOBAL: `${cap} everywhere`,
  };
  const choices = allowedScopes(request).map((s) => ({ label: ALLOW_LABEL[s], covers: covers[s] }));
  choices.push({ label: "Deny", covers: "refuse this operation; MORROW must find another way or stop" });
  if (request.taskId) choices.push({ label: "Deny for this task", covers: `refuse ${cap} for the rest of this task` });
  return choices;
}

/** Why the user is being asked. A request only exists when no grant allowed the operation. */
export function whyAsked(request: PermissionRequest): string {
  const risk = request.riskLevel.charAt(0) + request.riskLevel.slice(1).toLowerCase();
  return `${risk}-risk operations need your approval unless a permission you granted covers them. No current grant covers ${request.capability} here.`;
}

/** A requested operation awaiting the user, shown in place within the task. */
export function PermissionDecision({
  request,
  context,
  onRespond,
}: {
  request: PermissionRequest;
  context?: RequestContext;
  onRespond: RespondFn;
}) {
  const scopes = allowedScopes(request);
  const choices = scopeDescriptions(request, context?.projectName ?? null);
  const why = context
    ? [context.purpose ?? "No purpose was stated for this call", context.step ? `(${context.step})` : ""].join(" ").trim()
    : null;
  return (
    <article className="tv-decision tv-decision--permission" aria-label="Permission request">
      <div className="tv-decision__head">
        <Label tone="accent">Permission required</Label>
        <StateMark tone={RISK_TONE[request.riskLevel]} label={`${request.riskLevel} risk`} />
      </div>
      <p className="tv-decision__operation">{request.reason}</p>
      <KeyValue
        rows={[
          ...(why ? [["Why MORROW wants this", <span data-testid="permission-why">{why}</span>] as const] : []),
          ["Capability", <Mono>{request.capability}</Mono>],
          ["Tool", <Mono>{request.toolId}</Mono>],
          ["Resource", request.resource ? <Mono>{request.resource}</Mono> : <span className="tv-muted">None</span>],
          ["Why you are asked", <span data-testid="permission-asked">{whyAsked(request)}</span>],
        ]}
      />
      <div className="tv-decision__actions">
        {scopes.map((scope) => (
          <Button key={scope} variant={scope === "ONE_TIME" ? "primary" : "quiet"} onClick={() => onRespond(request.id, "ALLOW", scope)}>
            {ALLOW_LABEL[scope]}
          </Button>
        ))}
        <Button variant="danger" onClick={() => onRespond(request.id, "DENY", "ONE_TIME")}>
          Deny
        </Button>
        {request.taskId ? (
          <Button variant="danger" onClick={() => onRespond(request.id, "DENY", "TASK")}>
            Deny for this task
          </Button>
        ) : null}
      </div>
      <dl className="tv-scopes" aria-label="Scope of each choice" data-testid="permission-scopes">
        {choices.map((c) => (
          <div key={c.label} className="tv-scope">
            <dt>{c.label}</dt>
            <dd>{c.covers}</dd>
          </div>
        ))}
      </dl>
      {scopes.length === 1 && request.taskId ? (
        <p className="tv-muted">{request.riskLevel} risk operations can only be allowed one at a time.</p>
      ) : null}
    </article>
  );
}
