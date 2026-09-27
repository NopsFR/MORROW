import type { PermissionRequest } from "@morrow/schemas";
import { Button, Label, Mono, StateMark } from "@morrow/ui";
import { respondToPermission } from "../../runtime/store";
import { RISK_TONE } from "../format";

/**
 * Questions MORROW is waiting on. Answering here is the only way grants are
 * created; broader scopes are offered only where the risk level permits them.
 */
export function PermissionQueue({ requests }: { requests: readonly PermissionRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <section className="permissions" aria-label="Permission requests">
      {requests.map((r) => (
        <article key={r.id} className="permission">
          <div className="permission__head">
            <Label tone="accent">Permission required</Label>
            <StateMark tone={RISK_TONE[r.riskLevel]} label={`${r.riskLevel} risk`} />
          </div>
          <p className="permission__reason">{r.reason}</p>
          <div className="permission__meta">
            <Mono>{r.toolId}</Mono>
            <Mono>{r.capability}</Mono>
            {r.resource ? <Mono>{r.resource}</Mono> : null}
          </div>
          <div className="permission__actions">
            <Button variant="primary" onClick={() => void respondToPermission(r.id, "ALLOW", "ONE_TIME")}>
              Allow once
            </Button>
            {r.taskId && r.riskLevel !== "CRITICAL" ? (
              <Button onClick={() => void respondToPermission(r.id, "ALLOW", "TASK")}>Allow for this task</Button>
            ) : null}
            <Button variant="danger" onClick={() => void respondToPermission(r.id, "DENY", "ONE_TIME")}>
              Deny
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
