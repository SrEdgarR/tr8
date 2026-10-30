import { useEffect, useEffectEvent } from 'react';

/** Keep a modal mobile menu out of the underlying page's keyboard order. */
export default function useMobileNavigation(open: boolean, enabled: boolean, onClose: () => void) {
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!open) return;
    if (!enabled) {
      close();
      return;
    }
    const sidebar = document.getElementById('tr8-sidebar');
    if (!sidebar) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () =>
      [...sidebar.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')].filter(element => {
        const style = getComputedStyle(element);
        return (
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          !element.closest('[hidden],[inert]') &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    sidebar.querySelector<HTMLElement>('[data-mobile-nav-close]')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) return;
        const focused = document.activeElement;
        if (event.shiftKey && (focused === first || !sidebar.contains(focused))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (focused === last || !sidebar.contains(focused))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (trigger?.isConnected && getComputedStyle(trigger).display !== 'none') trigger.focus();
    };
  }, [open, enabled]);
}
