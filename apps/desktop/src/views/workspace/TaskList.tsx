import type { Task } from "@morrow/schemas";
import { Button, Mono, SectionHeader, StateMark } from "@morrow/ui";
import { cancelTask, resumeTask } from "../../runtime/store";
import { ACTIVE_TASK, TASK_TONE, TERMINAL_TASK, humanStatus, relativeTime } from "../format";

/** Tasks as the runtime reports them: status, and why, straight from the task record. */
export function TaskList({ tasks }: { tasks: readonly Task[] }) {
  if (tasks.length === 0) return null;
  return (
    <section className="tasks" aria-label="Tasks">
      <SectionHeader title="Tasks" />
      <ol className="tasks__list">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ol>
    </section>
  );
}

function TaskRow({ task }: { task: Task }) {
  const terminal = TERMINAL_TASK.includes(task.status);
  return (
    <li className="task" data-terminal={terminal || undefined}>
      <div className="task__head">
        <StateMark tone={TASK_TONE[task.status]} label={humanStatus(task.status)} pulse={ACTIVE_TASK.includes(task.status)} />
        <span className="task__title">{task.title}</span>
        <Mono className="task__time">{relativeTime(task.updatedAt)}</Mono>
      </div>
      {task.result ? (
        <div className="task__result">
          <p className="task__answer">{task.result.answer}</p>
          <StateMark
            tone={task.result.verification.passed ? "success" : "warning"}
            label={
              task.result.verification.passed
                ? `Verified · ${task.result.observationIds.length} observation${task.result.observationIds.length === 1 ? "" : "s"}`
                : "Not verified"
            }
          />
        </div>
      ) : null}
      {task.statusReason ? (
        <div className="task__reason">
          <Mono>{task.statusReason.code}</Mono>
          <span>{task.statusReason.message}</span>
        </div>
      ) : null}
      {!terminal ? (
        <div className="task__actions">
          {task.status === "PAUSED" ? <Button onClick={() => void resumeTask(task.id)}>Resume</Button> : null}
          <Button variant="danger" onClick={() => void cancelTask(task.id)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </li>
  );
}
