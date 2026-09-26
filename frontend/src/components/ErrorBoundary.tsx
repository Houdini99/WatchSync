import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render errors so one broken panel does not blank the whole app.
 *
 * Without this, any throw during render unmounts the entire tree and leaves a
 * white page with no way back — the room, the chat and the video all disappear
 * because, say, a queue item arrived in an unexpected shape.
 *
 * Deliberately a class: React has no hook equivalent for componentDidCatch.
 */
interface Props {
  children: ReactNode;
  /** Shown instead of the default panel, e.g. to scope a boundary to a sidebar. */
  fallback?: (reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept: sourcemaps are off in production builds, so the console message is
    // the only signal a user can report back.
    console.error('render error:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset);
    return (
      <div
        role="alert"
        className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p className="font-semibold">Something broke while rendering this view.</p>
        <p className="text-sm opacity-70">{this.state.error.message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-lg bg-accent px-4 py-2 font-semibold text-white transition hover:bg-accent-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => location.assign('/')}
            className="rounded-lg border border-border px-4 py-2 transition hover:bg-surface2"
          >
            Back to start
          </button>
        </div>
      </div>
    );
  }
}
