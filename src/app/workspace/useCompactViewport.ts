import { useEffect, useState } from 'react';

/** A presentation breakpoint only; it never changes permissions or loaded data. */
export default function useCompactViewport(query = '(max-width: 700px)') {
  const [compact, setCompact] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return compact;
}
