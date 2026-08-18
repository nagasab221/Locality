import { Component, type ReactNode } from "react";
import { btnGhost, btnPrimary } from "./ui";

/**
 * Catches render crashes so one bad component can't white-screen the app.
 * Used two ways: around the routed page in App (inside the path-keyed wrapper,
 * so navigating away resets it) and around the whole tree in main.tsx as a
 * last resort (`hard`, where recovery is a full reload).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; hard?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("render crash:", error, info?.componentStack ?? "");
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full min-h-[50vh] flex flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-display text-2xl text-heading">Something went wrong</h1>
        <p className="text-sm text-muted max-w-md break-words leading-relaxed">
          {String(this.state.error.message || this.state.error)}
        </p>
        <div className="flex gap-2">
          <button
            className={btnPrimary}
            onClick={() => (this.props.hard ? window.location.reload() : this.setState({ error: null }))}
          >
            Try again
          </button>
          {!this.props.hard && (
            <button className={btnGhost} onClick={() => window.location.reload()}>
              Reload app
            </button>
          )}
        </div>
      </div>
    );
  }
}
