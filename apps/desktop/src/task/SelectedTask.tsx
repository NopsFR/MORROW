import { useEffect, useState } from "react";
import { EmptyState } from "@morrow/ui";
import { cancelTask, pauseTask, resumeTask, selectTask, taskWorkspace, useTaskWorkspace } from "../runtime/store";
import { TaskView, type TaskActions } from "./TaskView";

const OPEN = new Set(["PLANNING", "EXECUTING", "OBSERVING", "AWAITING_PERMISSION", "VERIFYING", "RECOVERING"]);

/** Connects the task view to the selected task's live runtime state. */
export function SelectedTask() {
  const { detail, events, status, error } = useTaskWorkspace();
  const running = detail ? OPEN.has(detail.task.status) : false;
  const now = useClock(running ? 1000 : null);

  if (status === "loading" && !detail) return <EmptyState title="Loading task" />;
  if (status === "error" && !detail) return <EmptyState title="Could not load task">{error}</EmptyState>;
  if (!detail) return null;

  const id = detail.task.id;
  const actions: TaskActions = {
    respond: (requestId, decision, scope) => void taskWorkspace.respondToPermission(requestId, decision, scope),
    acceptMemory: (memoryId) => void taskWorkspace.acceptMemory(memoryId),
    rejectMemory: (memoryId) => void taskWorkspace.rejectMemory(memoryId, "Rejected by user"),
    pause: () => void pauseTask(id),
    resume: () => void resumeTask(id),
    cancel: () => void cancelTask(id),
    close: () => selectTask(null),
  };
  return <TaskView detail={detail} events={events} now={now} actions={actions} />;
}

/** Ticks only while a task is running, so elapsed time stays current. */
function useClock(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (intervalMs === null) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
