import type { Tone } from "@morrow/ui";
import type { InitCheckStatus, RiskLevel, TaskStatus } from "@morrow/schemas";

export const TASK_TONE: Record<TaskStatus, Tone> = {
  IDLE: "neutral",
  PLANNING: "signal",
  EXECUTING: "signal",
  OBSERVING: "signal",
  VERIFYING: "signal",
  RECOVERING: "warning",
  WAITING: "warning",
  AWAITING_PERMISSION: "accent",
  PAUSED: "neutral",
  COMPLETED: "success",
  FAILED: "error",
  CANCELLED: "neutral",
};

export const ACTIVE_TASK: readonly TaskStatus[] = ["PLANNING", "EXECUTING", "OBSERVING", "VERIFYING", "RECOVERING"];
export const TERMINAL_TASK: readonly TaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

export const RISK_TONE: Record<RiskLevel, Tone> = {
  SAFE: "neutral",
  LOW: "info",
  MEDIUM: "warning",
  HIGH: "error",
  CRITICAL: "error",
};

export const CHECK_TONE: Record<InitCheckStatus, Tone> = {
  READY: "success",
  DEGRADED: "warning",
  UNAVAILABLE: "neutral",
  FAILED: "error",
};

export function humanStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
