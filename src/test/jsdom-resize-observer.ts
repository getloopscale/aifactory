/**
 * jsdom lays nothing out, so it has no `ResizeObserver`, and a component that watches the size of an element
 * (the resizable panes of Code Mode) cannot mount in a suite. Nothing ever changes size there, so the one a suite
 * gets observes nothing and never calls back. A suite that runs in node is left alone.
 */
class NoLayoutResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof window !== 'undefined' && window.ResizeObserver === undefined) {
  window.ResizeObserver = NoLayoutResizeObserver
  globalThis.ResizeObserver = NoLayoutResizeObserver
}
