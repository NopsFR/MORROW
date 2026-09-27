import type { TaskDetail } from "@morrow/protocol";
import { Mono, SectionHeader } from "@morrow/ui";
import { formatTime } from "./model";

function bytes(n: number | null): string {
  if (n === null) return "size unknown";
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Artifacts the task produced, from the artifact registry. Hidden when there are none. */
export function ArtifactsSection({ detail }: { detail: TaskDetail }) {
  if (detail.artifacts.length === 0) return null;
  return (
    <section className="tv-section" aria-label="Artifacts">
      <SectionHeader title="Artifacts" trailing={<Mono>{detail.artifacts.length}</Mono>} />
      <ul className="tv-artifacts">
        {detail.artifacts.map((a) => (
          <li key={a.id} className="tv-artifact">
            <div className="tv-artifact__title">
              <span>{a.title}</span>
              <Mono>{a.kind}</Mono>
            </div>
            <Mono className="tv-artifact__uri">{a.uri}</Mono>
            <div className="tv-muted">
              {a.mimeType ?? "unknown type"} · {bytes(a.sizeBytes)} · {formatTime(a.createdAt)}
              {a.contentHash ? ` · sha256 ${a.contentHash.slice(0, 16)}…` : ""}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
