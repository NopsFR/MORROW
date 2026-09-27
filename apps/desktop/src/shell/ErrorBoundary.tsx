import { Component, type ErrorInfo, type ReactNode } from "react";
import { EmptyState } from "@morrow/ui";

/**
 * Contains a rendering failure to the region that failed, and says so, instead of
 * letting one component blank the whole environment. `resetKey` clears the error
 * when the region's subject changes (e.g. another task is selected).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label: string; resetKey?: unknown },
  { error: Error | null; key: unknown }
> {
  override state: { error: Error | null; key: unknown } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[morrow] ${this.props.label} failed to render`, error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{ padding: "var(--m-space-8) var(--m-space-10)" }}>
          <EmptyState title={`${this.props.label} could not be displayed`}>{this.state.error.message}</EmptyState>
        </div>
      );
    }
    return this.props.children;
  }
}
