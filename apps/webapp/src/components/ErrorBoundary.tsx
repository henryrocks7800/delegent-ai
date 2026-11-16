import { Component, type ErrorInfo, type ReactNode } from 'react';

// Without this, a throw during render unmounts the entire tree and leaves a
// blank white document: no navigation, no message, nothing to press, and no
// hint that reloading would help. React does that by design once no boundary
// claims the error. This catches it and gives the reader the one action that
// recovers, which is a fresh load of the app.
//
// Deliberately self-contained: no shared components, no router, no context. A
// fallback that depends on the tree it is standing in for can throw in turn,
// and React unmounts everything when a boundary's own render fails.

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is the only record of what happened, and it is gone once the
    // reader reloads, so put it somewhere they can be asked to read back.
    console.error('Delegent web app crashed while rendering', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
        <p className="font-brand text-display-lg italic text-textPrimary">Delegent AI</p>
        <p className="mt-4 text-body text-textPrimary">Something on this screen stopped working.</p>
        <p className="mt-2 text-body-sm text-textSecondary">
          Nothing has been lost. Your chat, files and routines are all still there. Loading the app again usually clears it.
        </p>
        <button className="btn-primary mt-6" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
