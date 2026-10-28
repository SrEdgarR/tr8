import { Component, createElement, lazy, Suspense, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Busy, ErrorNotice } from './ui';

class SectionBoundary extends Component<{ label: string; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return createElement(
        ErrorNotice,
        null,
        `No pudimos abrir ${this.props.label}. Revisa la conexión y vuelve a intentarlo. `,
        createElement('button', { type: 'button', className: 'btn btn-secondary btn-sm', onClick: this.props.onRetry }, 'Reintentar'),
      );
    }
    return this.props.children;
  }
}

/** Loads a section when it mounts, with a retry that keeps the surrounding workspace alive. */
export function deferSection<Props extends object>(load: () => Promise<{ default: ComponentType<Props> }>, label: string): ComponentType<Props> {
  return function DeferredSection(props: Props) {
    const [attempt, setAttempt] = useState(0);
    const Content = useMemo(() => {
      // A rejected React.lazy instance caches its error; a retry needs a fresh instance.
      void attempt;
      return lazy(load);
    }, [attempt]);
    return createElement(
      SectionBoundary,
      { key: attempt, label, onRetry: () => setAttempt(value => value + 1), children: null },
      createElement(Suspense, { fallback: createElement(Busy, null, `Abriendo ${label}…`) }, createElement(Content, props)),
    );
  };
}
