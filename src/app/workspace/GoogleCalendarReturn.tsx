import { useEffect, useRef } from 'react';
import { CalendarDays } from 'lucide-react';

/** Public, same-origin return page. It receives no OAuth parameters or credentials. */
export default function GoogleCalendarReturn() {
  const sent = useRef(false);
  const hasOpener = Boolean(window.opener);
  useEffect(() => {
    if (sent.current || !window.opener) return;
    sent.current = true;
    window.opener.postMessage({ type: 'tr8-google-oauth-ready' }, window.location.origin);
    window.close();
  }, []);
  return (
    <main className="app-status">
      <CalendarDays size={30} aria-hidden="true" />
      <h1>Volver a TR8</h1>
      <p role="status">
        {hasOpener
          ? 'Comprobaremos el resultado en la ventana principal. Si esta ventana sigue abierta, puedes cerrarla y volver a TR8.'
          : 'No encontramos la ventana que inició la conexión. Abre Configuración en TR8 y vuelve a conectar Google Calendar desde allí.'}
      </p>
    </main>
  );
}
