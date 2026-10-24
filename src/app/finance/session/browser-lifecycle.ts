import type { VaultSessionController } from './controller';

/** Caller must erase its rendered snapshot/drafts in the controller's onClear. */
export function bindVaultBrowserLifecycle(controller: VaultSessionController): () => void {
  const visibility = () => controller.setHidden(document.hidden);
  const pagehide = () => controller.lock('pagehide');
  const pageshow = () => {
    controller.lock('pagehide');
    controller.setHidden(document.hidden);
  };
  const activity = (event: Event) => {
    if (event.isTrusted) controller.noteActivity();
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow);
  for (const name of ['pointerdown', 'keydown', 'input']) document.addEventListener(name, activity, { passive: true });
  const timer = window.setInterval(() => controller.tick(), 1000);
  visibility();
  return () => {
    window.clearInterval(timer);
    controller.lock('navigation');
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', pageshow);
    for (const name of ['pointerdown', 'keydown', 'input']) document.removeEventListener(name, activity);
  };
}
