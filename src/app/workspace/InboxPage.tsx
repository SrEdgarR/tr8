import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, AtSign, Bell, CheckCheck, Inbox, Mail, MailOpen, MessageSquare, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import type { CommunicationApi, InboxNotification, InboxState } from '../communication-types';
import { IdentityAvatar } from './project-identity';
import { Busy, EmptyState, ErrorNotice, ProjectIcon } from './ui';
import { errorMessage } from './helpers';
import './communication.css';

export interface InboxPageProps {
  api: CommunicationApi;
  mode?: 'inbox' | 'notifications';
  onOpenTask: (taskId: string, projectId: string) => void;
  readOnly?: boolean;
  onChanged?: () => void;
}
type Kind = 'all' | InboxNotification['kind'];
const filters: { id: Kind; name: string; icon: typeof Inbox }[] = [
  { id: 'all', name: 'Todos', icon: Inbox },
  { id: 'mention', name: 'Menciones', icon: AtSign },
  { id: 'assignment', name: 'Asignaciones', icon: UserPlus },
  { id: 'comment', name: 'Comentarios', icon: MessageSquare },
];
const descriptions = { mention: 'te mencionó en un comentario', assignment: 'te asignó una tarea', comment: 'comentó en una tarea que sigues' };
const icons = { mention: AtSign, assignment: UserPlus, comment: MessageSquare };
const dateLabel = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const dayLabel = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'full' }).format(new Date(value));
const denied = (cause: unknown) =>
  typeof cause === 'object' && cause !== null && 'code' in cause && ['42501', 'PT404', 'PGRST301', 'PGRST303'].includes(String(cause.code));

export default function InboxPage(props: InboxPageProps) {
  return <ScopedInboxPage key={JSON.stringify([props.api.scopeKey, props.mode])} {...props} />;
}

function ScopedInboxPage({ api, mode = 'inbox', onOpenTask, readOnly = false, onChanged }: InboxPageProps) {
  const client = useQueryClient();
  const queryKey = [...api.scopeKey, 'inbox'];
  const active = useRef(true);
  const lock = useRef(false);
  const [filter, setFilter] = useState<Kind>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.inbox(signal),
    staleTime: 15000,
    retry: false,
  });
  const available = !!query.data && !query.error && !blocked;
  const all = available ? query.data!.items : [];
  const rows = all.filter(row => (filter === 'all' || row.kind === filter) && (!unreadOnly || row.read_at === null));
  const selected = rows.find(row => row.id === selectedId) ?? rows[0];
  const unread = available ? query.data!.unread_count : 0;
  function update(transform: (items: InboxNotification[]) => InboxNotification[]) {
    client.setQueryData<InboxState>(queryKey, previous => {
      if (!previous) return previous;
      const items = transform(previous.items);
      return { ...previous, items, unread_count: items.filter(row => row.read_at === null).length };
    });
  }
  async function refresh() {
    setError(null);
    const result = await query.refetch();
    if (!active.current) return;
    if (!result.error) setBlocked(false);
  }
  async function run(operation: () => Promise<void>) {
    if (readOnly || busy || lock.current || !available) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await operation();
      if (!active.current) return;
      onChanged?.();
      void client.invalidateQueries({ queryKey, exact: true });
    } catch (cause) {
      if (!active.current) return;
      setError(errorMessage(cause));
      if (denied(cause)) setBlocked(true);
      void query.refetch();
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  function setRead(row: InboxNotification) {
    const read = row.read_at === null;
    void run(async () => {
      await api.setRead(row.id, read);
      if (!active.current) return;
      update(items => items.map(item => (item.id === row.id ? { ...item, read_at: read ? new Date().toISOString() : null } : item)));
      setNotice(read ? 'Aviso marcado como leído.' : 'Aviso marcado como no leído.');
    });
  }
  function open(row: InboxNotification) {
    if (busy || !available) return;
    if (readOnly || row.read_at !== null) {
      onOpenTask(row.task_id, row.project_id);
      return;
    }
    void run(async () => {
      await api.setRead(row.id, true);
      if (!active.current) return;
      update(items => items.map(item => (item.id === row.id ? { ...item, read_at: new Date().toISOString() } : item)));
      onOpenTask(row.task_id, row.project_id);
    });
  }
  function readAll() {
    void run(async () => {
      await api.readAll();
      if (!active.current) return;
      update(items => items.map(item => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })));
      setNotice('Todos los avisos disponibles están leídos.');
    });
  }
  function dismiss(row: InboxNotification) {
    void run(async () => {
      await api.dismiss(row.id);
      if (!active.current) return;
      update(items => items.filter(item => item.id !== row.id));
      setNotice('Aviso retirado. La tarea y sus comentarios se conservan.');
    });
  }

  return (
    <section className="page ci-page" aria-label={mode === 'inbox' ? 'Bandeja de entrada' : 'Notificaciones'}>
      <div className="ph">
        <div>
          <h1>
            {mode === 'inbox' ? <Inbox size={23} aria-hidden="true" /> : <Bell size={23} aria-hidden="true" />}
            {mode === 'inbox' ? 'Bandeja de entrada' : 'Notificaciones'}
          </h1>
          <p>Menciones, asignaciones y comentarios de tus proyectos.</p>
        </div>
        <div className="acts">
          <button type="button" className="btn btn-secondary" disabled={busy || query.isFetching} onClick={() => void refresh()}>
            <RefreshCw size={14} aria-hidden="true" />
            Actualizar
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy || readOnly || !unread || !available} onClick={readAll}>
            <CheckCheck size={15} aria-hidden="true" />
            Marcar todas como leídas
          </button>
        </div>
      </div>
      <div className="ci-filters">
        <div className="ci-categories" aria-label="Tipos de notificación">
          {filters.map(item => (
            <button key={item.id} type="button" className={filter === item.id ? 'on' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
              <item.icon size={14} aria-hidden="true" />
              {item.name} {available && <span>{item.id === 'all' ? all.length : all.filter(row => row.kind === item.id).length}</span>}
            </button>
          ))}
        </div>
        <label className="ci-unread">
          <input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} />
          Solo no leídos{unread > 0 && <span className="ci-unread-count">{unread}</span>}
        </label>
      </div>
      {query.isPending && <Busy>Cargando tus avisos…</Busy>}
      {(error || query.error) && <ErrorNotice>{error ?? errorMessage(query.error)}</ErrorNotice>}
      {notice && (
        <p className="tc-notice" role="status">
          <CheckCheck size={14} aria-hidden="true" />
          {notice}
        </p>
      )}
      {blocked && <p className="muted">Actualiza la bandeja para comprobar tu acceso.</p>}
      {available &&
        (rows.length ? (
          <div className={`ci-layout${mode === 'notifications' ? ' ci-notification-mode' : ''}`}>
            <div className="ci-list" aria-label="Avisos del espacio">
              {rows.map((row, index) => {
                const Icon = icons[row.kind];
                const group = mode === 'notifications' && (index === 0 || dayLabel(rows[index - 1].created_at) !== dayLabel(row.created_at));
                return (
                  <div key={row.id}>
                    {group && <h2 className="ci-day">{dayLabel(row.created_at)}</h2>}
                    <button
                      type="button"
                      className={`ci-row${row.read_at === null ? ' unread' : ''}${selected?.id === row.id ? ' selected' : ''}`}
                      aria-pressed={selected?.id === row.id}
                      onClick={() => setSelectedId(row.id)}
                    >
                      <span className={`ci-kind-icon ci-kind-${row.kind}`}>
                        <Icon size={17} aria-hidden="true" />
                      </span>
                      <span className="ci-row-body">
                        <span className="ci-row-title">
                          <strong>{row.actor_name}</strong>
                          <time dateTime={row.created_at}>{dateLabel(row.created_at)}</time>
                        </span>
                        <span className="ci-row-action">{descriptions[row.kind]}</span>
                        <span className="ci-row-task">{row.task_title}</span>
                        <span className="ci-row-project">
                          <ProjectIcon icon={row.project_icon} color={row.project_color} />
                          {row.project_name}
                        </span>
                      </span>
                      {row.read_at === null && <span className="ci-unread-dot" aria-label="No leído" />}
                    </button>
                  </div>
                );
              })}
            </div>
            {selected && (
              <section className="ci-detail" aria-label="Detalle del aviso">
                <div className="ci-detail-actions">
                  <button
                    type="button"
                    className="ibtn"
                    aria-label={selected.read_at === null ? 'Marcar aviso como leído' : 'Marcar aviso como no leído'}
                    disabled={busy || readOnly}
                    onClick={() => setRead(selected)}
                  >
                    {selected.read_at === null ? <MailOpen size={17} aria-hidden="true" /> : <Mail size={17} aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="ibtn btn-danger-ghost"
                    aria-label="Retirar aviso"
                    disabled={busy || readOnly}
                    onClick={() => dismiss(selected)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
                <div className="ci-detail-person">
                  <IdentityAvatar name={selected.actor_name} decorative />
                  <div>
                    <strong>{selected.actor_name}</strong>
                    <p>{descriptions[selected.kind]}</p>
                    <time dateTime={selected.created_at}>{dateLabel(selected.created_at)}</time>
                  </div>
                </div>
                <div className="ci-detail-task">
                  <span className="ci-row-project">
                    <ProjectIcon icon={selected.project_icon} color={selected.project_color} />
                    {selected.project_name}
                  </span>
                  <h2>{selected.task_title}</h2>
                  <p>Abre la tarea para consultar la conversación y responder con su contexto.</p>
                </div>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => open(selected)}>
                  Abrir tarea y responder
                  <ArrowUpRight size={15} aria-hidden="true" />
                </button>
              </section>
            )}
          </div>
        ) : (
          <EmptyState title={unreadOnly ? 'Todo al día' : filter === 'all' ? 'Tu bandeja está al día' : 'No hay avisos de este tipo'}>
            {unreadOnly ? 'No quedan avisos sin leer con estos filtros.' : 'Aquí aparecerán las menciones, asignaciones y comentarios que te correspondan.'}
          </EmptyState>
        ))}
      <p className="ci-retention">Se conservan los últimos 200 avisos de este espacio. Solo se muestran aquellos a los que todavía tienes acceso.</p>
    </section>
  );
}
