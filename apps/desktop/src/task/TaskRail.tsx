import type { Task } from "@morrow/schemas";
import { Label, StateMark } from "@morrow/ui";
import { ACTIVE_TASK, TASK_TONE, humanStatus, relativeTime } from "../views/format";
import { selectTask } from "../runtime/store";

/** Tasks, newest first. Selecting one opens its live view. */
export function TaskRail({ tasks, selectedId }: { tasks: readonly Task[]; selectedId: string | null }) {
  return (
    <nav className="task-rail" aria-label="Tasks">
      <Label>Tasks</Label>
      <ol>
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="task-rail__item"
              aria-current={t.id === selectedId ? "true" : undefined}
              onClick={() => selectTask(t.id === selectedId ? null : t.id)}
            >
              <StateMark tone={TASK_TONE[t.status]} label={humanStatus(t.status)} pulse={ACTIVE_TASK.includes(t.status)} />
              <span className="task-rail__title">{t.title}</span>
              <span className="task-rail__time">{relativeTime(t.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
