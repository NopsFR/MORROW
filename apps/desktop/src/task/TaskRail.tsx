import { useMemo, useRef, useState } from "react";
import type { Task } from "@morrow/schemas";
import { IconButton, SearchField, Segmented, StateMark } from "@morrow/ui";
import { ACTIVE_TASK, TASK_TONE, TERMINAL_TASK, humanStatus, relativeTime } from "../views/format";
import { selectTask, setHistoryFilter, setHistoryOpen, useMorrow, type HistoryFilter } from "../runtime/store";
import { outcomeLine } from "../views/workspace/WorkspaceHome";

/** Below this width the history panel replaces the stage instead of sitting beside it (workspace.css). */
const NARROW = "(max-width: 820px)";

const FILTERS: Record<HistoryFilter, (t: Task) => boolean> = {
  ALL: () => true,
  OPEN: (t) => !TERMINAL_TASK.includes(t.status),
  COMPLETED: (t) => t.status === "COMPLETED",
  FAILED: (t) => t.status === "FAILED",
};

/** The day a task was created, as a group heading. Groups follow the list order; nothing is reordered. */
function dayOf(ts: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Tasks, newest first — the records exactly as the runtime lists them. Search and the
 * status filter only narrow what is shown; selecting a task opens its live view.
 */
export function TaskRail({ tasks, selectedId }: { tasks: readonly Task[]; selectedId: string | null }) {
  const filter = useMorrow((s) => s.historyFilter);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{ task: Task; top: number; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => FILTERS[filter](t) && (!q || t.title.toLowerCase().includes(q) || t.objective.toLowerCase().includes(q)));
  }, [tasks, filter, query]);
  const count = (f: HistoryFilter) => tasks.filter(FILTERS[f]).length;

  // Consecutive runs of the same day become groups (order is preserved).
  const groups: Array<{ day: string; tasks: Task[] }> = [];
  for (const t of shown) {
    const day = dayOf(t.createdAt);
    const last = groups.at(-1);
    if (last && last.day === day) last.tasks.push(t);
    else groups.push({ day, tasks: [t] });
  }

  const showPreview = (task: Task, el: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // The panel (backdrop-filter) is the containing block: position relative to it.
      const panel = el.closest(".task-rail")!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const top = Math.min(r.top - panel.top, panel.height - 240);
      setPreview({ task, top: Math.max(0, top), left: panel.width + 12 });
    }, 380);
  };
  const hidePreview = () => {
    window.clearTimeout(timer.current);
    setPreview(null);
  };

  return (
    <nav className="task-rail m-panel m-panel--glass" aria-label="Tasks">
      <header className="task-rail__header">
        <span className="m-label m-tone-secondary">Tasks</span>
        <span className="task-rail__count">{tasks.length}</span>
        <IconButton icon="close" label="Hide history" onClick={() => setHistoryOpen(false)} />
      </header>
      <div className="task-rail__tools">
        <SearchField label="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented<HistoryFilter>
          label="Show tasks"
          value={filter}
          onChange={setHistoryFilter}
          options={[
            { value: "ALL", label: "All", count: count("ALL") },
            { value: "OPEN", label: "Open", count: count("OPEN") },
            { value: "COMPLETED", label: "Done", count: count("COMPLETED") },
            { value: "FAILED", label: "Failed", count: count("FAILED") },
          ]}
        />
      </div>
      <div className="task-rail__list" onScroll={hidePreview}>
        {groups.length === 0 ? <p className="task-rail__empty">No task matches this search and filter.</p> : null}
        {groups.map((g) => (
          <section key={g.day + g.tasks[0]!.id} className="task-rail__group" aria-label={g.day}>
            <h3 className="task-rail__day">{g.day}</h3>
            <ol>
              {g.tasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="task-rail__item"
                    data-status={t.status}
                    aria-current={t.id === selectedId ? "true" : undefined}
                    onClick={() => {
                      hidePreview();
                      selectTask(t.id === selectedId ? null : t.id);
                      // On a narrow window the history covers the stage: step aside so the task shows.
                      if (window.matchMedia(NARROW).matches) setHistoryOpen(false);
                    }}
                    onMouseEnter={(e) => showPreview(t, e.currentTarget)}
                    onMouseLeave={hidePreview}
                    onFocus={(e) => showPreview(t, e.currentTarget)}
                    onBlur={hidePreview}
                  >
                    <StateMark tone={TASK_TONE[t.status]} label={humanStatus(t.status)} pulse={ACTIVE_TASK.includes(t.status)} />
                    <span className="task-rail__title">{t.title}</span>
                    <span className="task-rail__time">{relativeTime(t.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      {preview ? <TaskPreview {...preview} /> : null}
    </nav>
  );
}

/** What a task asked and what it came to, from its record, beside the history. */
function TaskPreview({ task, top, left }: { task: Task; top: number; left: number }) {
  const outcome = outcomeLine(task);
  return (
    <div className="task-preview m-panel m-panel--raised" role="tooltip" style={{ top, left }}>
      <StateMark tone={TASK_TONE[task.status]} label={humanStatus(task.status)} />
      <p className="task-preview__objective">{task.objective}</p>
      {outcome ? (
        <p className="task-preview__outcome" data-status={task.status}>
          {task.status === "COMPLETED" ? "Answer: " : `${task.statusReason?.code ?? "Reason"}: `}
          {outcome}
        </p>
      ) : null}
      <p className="task-preview__meta">
        Created {new Date(task.createdAt).toLocaleString()} · updated {relativeTime(task.updatedAt)}
      </p>
    </div>
  );
}
