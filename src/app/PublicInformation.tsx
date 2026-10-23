import { CalendarDays, FolderKanban, ListTodo, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import Brand from './brand/Brand';
import './public-information.css';

function Privacy() {
  return (
    <>
      <section>
        <h2>Una aplicación privada</h2>
        <p>
          TR8 se utiliza de forma personal y el registro no está abierto al público. El propietario administra el acceso a la aplicación. TR8 no utiliza
          publicidad ni vende tus datos.
        </p>
      </section>
      <section>
        <h2>Cuenta, proyectos y tareas</h2>
        <p>
          Supabase gestiona la autenticación y la base de datos con tu cuenta, proyectos, tareas, permisos y preferencias de calendario. Vercel sirve la
          interfaz de TR8. Los datos de los proyectos se muestran según los permisos vigentes de cada usuario.
        </p>
      </section>
      <section>
        <h2>Google Calendar es opcional</h2>
        <p>
          La conexión requiere tu consentimiento desde Configuración. TR8 copia a un calendario independiente llamado TR8 las tareas personales y las asignadas
          a ti en equipos, con fecha u horario y acceso vigente.
        </p>
        <p>
          La copia incluye el título de la tarea, nombre del proyecto, fechas, horario, estado y enlace a TR8. No incluye descripciones completas, datos
          financieros ni contenido de Pulso. Completar una tarea conserva su evento con la marca «Hecha».
        </p>
        <p>
          Se solicita únicamente el permiso de Google para los calendarios creados por esta aplicación (<code>calendar.app.created</code>). La integración no
          solicita acceso general a tu calendario principal, Gmail o Drive. Los cambios hechos en Google no modifican las tareas de TR8.
        </p>
      </section>
      <section>
        <h2>Google Tasks, si lo activas</h2>
        <p>
          Google Tasks es un servicio diferente de los eventos de Calendar. Puedes ampliar voluntariamente la conexión para importar las tareas de las listas
          que elijas a un proyecto personal Google Tasks. Se sincronizan título, día de programación y estado; las descripciones, notas y datos financieros no
          se copian.
        </p>
        <p>
          Google exige el permiso general <code>tasks</code>, que permite gestionar tus tareas y no se puede limitar técnicamente a una lista. TR8 aplica tu
          selección de listas y solo modifica las tareas que haya vinculado. Las tareas asignadas desde Docs o Chat no se importan. No se crea un segundo evento
          de Calendar para las tareas importadas.
        </p>
        <p>
          Las ediciones, finalización y eliminación de tareas vinculadas se sincronizan en ambos sentidos. Si existen cambios incompatibles se conservan para
          que elijas cuál aplicar. La API de Google Tasks permite el día de programación, pero no su hora. El vencimiento de TR8 continúa siendo independiente.
        </p>
        <p>
          Puedes pausar Google Tasks sin revocar la conexión común. Desconectar Google detiene ambas integraciones y conserva las tareas de Google Tasks y sus
          proyectos importados; la opción de retirar copias solo se refiere a los eventos de Calendar registrados por TR8.
        </p>
      </section>
      <section>
        <h2>Protección de la conexión</h2>
        <p>
          Las funciones de Supabase procesan la autorización y la sincronización. Las credenciales de Google se guardan cifradas en el servidor, con una clave
          administrada fuera de la base de datos. Los tokens de Google no se entregan a la interfaz ni se incorporan al código público.
        </p>
        <p>
          El calendario externo es una copia de la planificación autorizada. Al reconciliar, TR8 puede restablecer sus datos sobre las ediciones hechas en
          Google.
        </p>
      </section>
      <section>
        <h2>Desconectar y gestionar las copias</h2>
        <p>
          Desde Configuración puedes elegir conservar los eventos o intentar retirar únicamente los eventos registrados por TR8 antes de terminar la
          desconexión. No se elimina el calendario completo ni los eventos ajenos a TR8.
        </p>
        <p>
          Si Google ya retiró el permiso o la limpieza falla, algunas copias podrían permanecer. TR8 muestra los pendientes y permite reintentar o conservar los
          restantes; no puede garantizar retirarlos sin autorización. Puedes gestionar esas copias directamente en Google Calendar.
        </p>
      </section>
    </>
  );
}
function About() {
  return (
    <>
      <section>
        <h2>Tu trabajo, en un solo lugar</h2>
        <p>
          TR8 es una aplicación privada para organizar proyectos, tareas y planificación personal. Combina un espacio propio con equipos separados y acceso
          configurable a los proyectos.
        </p>
      </section>
      <div className="tr8-public-features">
        <section>
          <FolderKanban size={20} aria-hidden="true" />
          <h2>Proyectos</h2>
          <p>Organiza objetivos y conserva el contexto de cada proyecto.</p>
        </section>
        <section>
          <ListTodo size={20} aria-hidden="true" />
          <h2>Lista y tablero</h2>
          <p>Gestiona tareas, responsables y estados con distintas vistas.</p>
        </section>
        <section>
          <CalendarDays size={20} aria-hidden="true" />
          <h2>Planificación</h2>
          <p>Consulta fechas y bloques horarios en el calendario de tus proyectos.</p>
        </section>
      </div>
      <section>
        <h2>Google Calendar, con tu permiso</h2>
        <p>
          La integración opcional lleva tus tareas personales y las asignadas a ti a un calendario secundario llamado TR8. La sincronización va de TR8 a Google;
          tus proyectos y tareas siguen gestionándose desde TR8.
        </p>
        <p>
          También puedes activar Google Tasks para sincronizar en ambos sentidos las tareas de las listas elegidas, sin duplicarlas como eventos. La conexión
          necesita un consentimiento adicional.
        </p>
        <p>
          La conexión se inicia desde Configuración y requiere tu consentimiento. Antes de conectar puedes{' '}
          <Link to="/privacy">consultar cómo se usan los datos y cómo desconectar</Link>.
        </p>
      </section>
      <section>
        <h2>Acceso personal</h2>
        <p>El registro no está abierto al público. El propietario administra esta aplicación privada y sus accesos.</p>
      </section>
    </>
  );
}

/** Public information required before consenting, without querying account data. */
export default function PublicInformation({ page }: { page: 'privacy' | 'about' }) {
  const privacy = page === 'privacy';
  return (
    <main className="tr8-public">
      <div className="tr8-public-inner">
        <header className="tr8-public-nav">
          <Link to="/" aria-label="Volver a TR8">
            <Brand height={25} />
          </Link>
          <nav aria-label="Información de TR8">
            <Link to="/about" aria-current={!privacy ? 'page' : undefined}>
              Acerca de TR8
            </Link>
            <Link to="/privacy" aria-current={privacy ? 'page' : undefined}>
              Privacidad
            </Link>
          </nav>
        </header>
        <div className="tr8-public-intro">
          <span className="tr8-public-icon">{privacy ? <ShieldCheck size={24} aria-hidden="true" /> : <FolderKanban size={24} aria-hidden="true" />}</span>
          <p className="eyebrow">TR8 · Organización personal</p>
          <h1>{privacy ? 'Privacidad en TR8' : 'Un lugar para avanzar'}</h1>
          <p>
            {privacy ? 'Cómo se usan tus datos y qué compartes al conectar Google Calendar.' : 'Proyectos, tareas y calendario para dar forma a tu trabajo.'}
          </p>
        </div>
        <article className="tr8-public-content" aria-label={privacy ? 'Información de privacidad' : 'Acerca de TR8'}>
          {privacy ? <Privacy /> : <About />}
        </article>
        <footer className="tr8-public-footer">
          <p>
            Aplicación privada administrada por su propietario.
            <br />
            Contacto:{' '}
            <a href="https://github.com/SrEdgarR" target="_blank" rel="noopener noreferrer">
              SrEdgarR en GitHub
            </a>
            .
          </p>
          <Link to="/" className="btn btn-primary btn-sm">
            Entrar a TR8
          </Link>
        </footer>
      </div>
    </main>
  );
}
