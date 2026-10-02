import { useState } from "react";
import { MODEL_PURPOSES, type Model, type ModelPreferences, type ModelProvider, type ModelPurpose } from "@morrow/schemas";
import { Button, EmptyState, ErrorState, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { request } from "../../runtime/bridge";
import { refreshModels, useMorrow } from "../../runtime/store";
import { useResource } from "../../runtime/use-resource";
import { relativeTime } from "../format";
import { ViewFrame, ViewPanel, WithResource, whenConnected } from "../ViewFrame";

const PROVIDER_TONE = { READY: "success", UNREACHABLE: "warning", UNCONFIGURED: "neutral", ERROR: "error" } as const;
const EMPTY = { providers: [] as ModelProvider[], models: [] as Model[] };

/** What each purpose is, in the words the task view uses. */
const PURPOSE: Record<ModelPurpose, { name: string; detail: string }> = {
  PLAN: { name: "Planning", detail: "Writes the plan and its success criteria" },
  DECIDE: { name: "Each action", detail: "Chooses the next tool call or step outcome" },
  COMPOSE: { name: "The result", detail: "Writes the answer from the evidence" },
  VERIFY: { name: "Verification", detail: "Judges each criterion against the evidence" },
};

function capabilityList(m: Model): string {
  const caps = Object.entries(m.capabilities)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return caps.length ? caps.join(", ") : "none reported";
}

export function ModelsPage() {
  const connected = useMorrow((s) => s.runtime?.state === "RUNNING");
  const [refreshing, setRefreshing] = useState(false);
  const [status, reload] = useResource(whenConnected(connected, () => request("models.status"), EMPTY), [connected]);

  async function refresh() {
    setRefreshing(true);
    try {
      // Probe providers through the store, so the shell's presence reflects the result too.
      await refreshModels(true);
    } finally {
      setRefreshing(false);
      void reload();
    }
  }

  return (
    <ViewFrame
      icon="models"
      title="Models"
      lede="MORROW is not tied to one provider. Providers are probed for what they actually offer; capabilities are shown only when the provider reports them."
    >
      <ViewPanel>
        <SectionHeader
          title="Providers"
          icon="runtime"
          trailing={
            connected ? (
              <Button size="sm" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Checking" : "Check again"}
              </Button>
            ) : null
          }
        />
        <WithResource resource={status}>
          {({ providers }) =>
            providers.length === 0 ? (
              <EmptyState title="No providers configured" />
            ) : (
              <div className="rows">
                {providers.map((p) => (
                  <div key={p.id} className="row" style={{ gridTemplateColumns: "150px 1fr 1fr 110px" }}>
                    <StateMark tone={PROVIDER_TONE[p.state]} label={p.state} />
                    <span>{p.displayName}</span>
                    <Mono>{p.stateMessage ?? p.endpoint ?? ""}</Mono>
                    <span className="row__sub">{p.checkedAt ? relativeTime(p.checkedAt) : "never checked"}</span>
                  </div>
                ))}
              </div>
            )
          }
        </WithResource>
      </ViewPanel>
      <ViewPanel>
        <SectionHeader title="Models" icon="models" />
        <WithResource resource={status}>
          {({ models }) =>
            models.length === 0 ? (
              <EmptyState title="No models discovered">
                No provider has reported any models. Install and start a local model server such as Ollama, then check
                again.
              </EmptyState>
            ) : (
              <div className="rows">
                {models.map((m) => (
                  <div key={m.id} className="row" style={{ gridTemplateColumns: "130px 1fr 1fr 100px" }}>
                    <StateMark tone={m.available ? "success" : "neutral"} label={m.available ? "Available" : "Missing"} />
                    <span>{m.displayName}</span>
                    <Mono>{capabilityList(m)}</Mono>
                    <Mono>{m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k ctx` : m.locality}</Mono>
                  </div>
                ))}
              </div>
            )
          }
        </WithResource>
      </ViewPanel>
      <ViewPanel>
        <SectionHeader title="Routing" icon="plan" />
        <p className="settings__note">
          Which model does each part of a task. Automatic lets MORROW&apos;s router choose from the models that report
          what the purpose needs; a choice here is used whenever that model is available.
        </p>
        <WithResource resource={status}>{({ models }) => <Routing models={models.filter((m) => m.available)} />}</WithResource>
      </ViewPanel>
    </ViewFrame>
  );
}

function Routing({ models }: { models: readonly Model[] }) {
  const [preferences, reload] = useResource(() => request("models.getPreferences"), []);
  const [saving, setSaving] = useState<ModelPurpose | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(purpose: ModelPurpose, modelId: string) {
    setSaving(purpose);
    setError(null);
    try {
      await request("models.setPreference", { purpose, modelId: (modelId || null) as Model["id"] | null });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

  if (preferences.status === "loading") return null;
  if (preferences.status === "error") return <ErrorState title="Could not load routing">{preferences.message}</ErrorState>;
  const chosen: ModelPreferences = preferences.data;
  return (
    <>
      <div className="routing">
        {MODEL_PURPOSES.map((purpose) => (
          <label key={purpose} className="routing__row">
            <span className="routing__purpose">
              <span className="routing__name">{PURPOSE[purpose].name}</span>
              <span className="routing__detail">{PURPOSE[purpose].detail}</span>
            </span>
            <select
              className="m-input routing__select"
              value={chosen[purpose] ?? ""}
              disabled={saving !== null}
              onChange={(e) => void choose(purpose, e.target.value)}
            >
              <option value="">Automatic</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
              {/* A preference for a model that is no longer available is shown, not hidden. */}
              {chosen[purpose] && !models.some((m) => m.id === chosen[purpose]) ? (
                <option value={chosen[purpose]}>Unavailable model</option>
              ) : null}
            </select>
          </label>
        ))}
      </div>
      {error ? <ErrorState title="Not saved">{error}</ErrorState> : null}
    </>
  );
}
