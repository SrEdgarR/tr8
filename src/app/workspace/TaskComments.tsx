import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { AtSign, Check, ChevronUp, MessageSquare, Pencil, RefreshCw, Send, SmilePlus, Trash2, X } from 'lucide-react';
import type { CommunicationApi, CommentThread, MentionMember, ReactionEmoji, TaskComment } from '../communication-types';
import { COMMENT_MAX_LENGTH, COMMENT_REACTIONS } from '../communication-types';
import type { Task } from '../types';
import { IdentityAvatar } from './project-identity';
import { Busy, Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import './communication.css';

export interface TaskCommentsProps {
  focusCommentId?: string | null;
  task: Task;
  api: CommunicationApi;
  readOnly: boolean;
  pending?: boolean;
  canComment?: boolean;
  onChanged?: () => void;
}
type SendAttempt = { id: string; body: string; mentions: string[] };
type CommentAction = { kind: 'edit' | 'delete'; row: TaskComment };
const denied = (cause: unknown) =>
  typeof cause === 'object' && cause !== null && 'code' in cause && ['42501', 'PT404', 'PGRST301', 'PGRST303'].includes(String(cause.code));
const dateLabel = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/** A different account, permission scope or task never inherits a conversation draft. */
export default function TaskComments(props: TaskCommentsProps) {
  return <ScopedTaskComments key={JSON.stringify([props.api.scopeKey, props.task.workspace_id, props.task.project_id, props.task.id])} {...props} />;
}

function ScopedTaskComments({ task, api, readOnly, pending = false, canComment = true, onChanged, focusCommentId }: TaskCommentsProps) {
  const client = useQueryClient();
  const queryKey = [...api.scopeKey, 'comments', task.workspace_id, task.project_id, task.id];
  const headingId = useId();
  const threadElement = useRef<HTMLDivElement>(null);
  const focusedComment = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const active = useRef(true);
  const lock = useRef(false);
  const attempt = useRef<SendAttempt | null>(null);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<MentionMember[]>([]);
  const [picker, setPicker] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [reactionFor, setReactionFor] = useState<string | null>(null);
  const [action, setAction] = useState<CommentAction | null>(null);
  const [editBody, setEditBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.thread(task, pageParam, signal);
      if (!active.current || signal.aborted) throw new Error('La conversación cambió durante la consulta.');
      return result;
    },
    getNextPageParam: (page: CommentThread) => page.next_before_id ?? undefined,
    staleTime: 15000,
    refetchOnMount: focusCommentId ? 'always' : true,
    retry: false,
  });
  const available = !blocked && !query.error && !!query.data;
  const all = available ? query.data!.pages.flatMap(page => page.items).filter(row => row.task_id === task.id && row.workspace_id === task.workspace_id) : [];
  const rows = [...new Map(all.map(row => [row.id, row])).values()].sort((a, b) => a.sequence - b.sequence);
  const participants = available ? query.data!.pages[0].participants : [];
  const people = participants.filter(
    row =>
      !mentions.some(mention => mention.member_id === row.member_id) && row.display_name.toLocaleLowerCase('es').includes(peopleQuery.toLocaleLowerCase('es')),
  );
  const canMutate = available && !readOnly && !task.archived_at;
  const canParticipate = canMutate && canComment;
  const mutable = canMutate && !pending;
  const writable = mutable && canComment;
  const actionPending = busy || pending;
  const bodyLength = Array.from(body).length;
  const currentAction = available && action ? rows.find(row => row.id === action.row.id) : undefined;
  const targetLoaded = rows.some(row => row.id === focusCommentId);
  const { isFetching: threadFetching, hasNextPage: threadHasNextPage, fetchNextPage: fetchOlderComments } = query;
  const threadPageCount = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (!focusCommentId || !available || threadFetching || focusedComment.current === focusCommentId) return;
    if (!targetLoaded && threadHasNextPage && threadPageCount < 10) {
      void fetchOlderComments();
      return;
    }
    focusedComment.current = focusCommentId;
    const element = Array.from(threadElement.current?.querySelectorAll<HTMLElement>('[data-comment-id]') ?? []).find(
      row => row.dataset.commentId === focusCommentId,
    );
    if (element) {
      element.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      element.focus({ preventScroll: true });
    } else setNotice('El comentario ya no está disponible. Actualiza la búsqueda para comprobarlo.');
  }, [focusCommentId, available, targetLoaded, threadFetching, threadHasNextPage, threadPageCount, fetchOlderComments]);

  function accept(saved: TaskComment) {
    client.setQueryData<InfiniteData<CommentThread, number | null>>(queryKey, previous => {
      if (!previous) return previous;
      const exists = previous.pages.some(page => page.items.some(row => row.id === saved.id));
      return {
        ...previous,
        pages: previous.pages.map((page, index) => ({
          ...page,
          items: exists ? page.items.map(row => (row.id === saved.id ? saved : row)) : index === 0 ? [saved, ...page.items] : page.items,
        })),
      };
    });
  }
  async function refresh() {
    const result = await query.refetch();
    if (!active.current) return;
    if (!result.error) setBlocked(false);
  }
  async function run(operation: () => Promise<void>) {
    if (!mutable || busy || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      if (!active.current) return;
      setError(errorMessage(cause));
      if (denied(cause)) {
        setBlocked(true);
        setAction(null);
        setReactionFor(null);
      }
      void query.refetch();
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!writable || busy || !body.trim() || bodyLength > COMMENT_MAX_LENGTH) return;
    const sent = attempt.current ?? { id: crypto.randomUUID(), body: body.trim(), mentions: mentions.map(row => row.member_id) };
    attempt.current = sent;
    void run(async () => {
      try {
        const saved = await api.create(task, sent.id, sent.body, sent.mentions);
        if (!active.current) return;
        accept(saved);
        attempt.current = null;
        setBody('');
        setMentions([]);
        setPicker(false);
        setUnconfirmed(false);
        setNotice('Comentario publicado.');
        onChanged?.();
        void client.invalidateQueries({ queryKey: [...api.scopeKey, 'inbox'], exact: true });
        void query.refetch();
      } catch (cause) {
        if (active.current) {
          const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
          const rejected = ['22023', '22P02', '23514', 'PT413', 'PT409', '55000'].includes(code);
          if (rejected) attempt.current = null;
          setUnconfirmed(!rejected);
        }
        throw cause;
      }
    });
  }
  function choose(person: MentionMember) {
    if (!writable || busy || unconfirmed || mentions.length >= 10) return;
    setMentions(previous => [...previous, person]);
    setBody(previous => previous.replace(/(^|\s)@[^\s@]*$/, '$1'));
    setPicker(false);
    setPeopleQuery('');
    textarea.current?.focus();
  }
  function bodyKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && picker) {
      event.preventDefault();
      event.stopPropagation();
      setPicker(false);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  function react(row: TaskComment, emoji: ReactionEmoji) {
    const desired = !row.reactions.some(reaction => reaction.emoji === emoji && reaction.mine);
    void run(async () => {
      const saved = await api.react(row, emoji, desired);
      if (!active.current) return;
      accept(saved);
      setReactionFor(null);
      onChanged?.();
      void query.refetch();
    });
  }
  function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!writable || !action || action.kind !== 'edit' || !currentAction?.can_edit || !editBody.trim() || Array.from(editBody).length > COMMENT_MAX_LENGTH)
      return;
    void run(async () => {
      const saved = await api.update(action.row, editBody.trim());
      if (!active.current) return;
      accept(saved);
      setAction(null);
      setNotice('Comentario actualizado.');
      onChanged?.();
      void query.refetch();
    });
  }
  function remove() {
    if (!action || action.kind !== 'delete' || !currentAction?.can_delete) return;
    void run(async () => {
      await api.remove(action.row);
      if (!active.current) return;
      client.setQueryData<InfiniteData<CommentThread, number | null>>(queryKey, previous =>
        previous ? { ...previous, pages: previous.pages.map(page => ({ ...page, items: page.items.filter(row => row.id !== action.row.id) })) } : previous,
      );
      setAction(null);
      setNotice('Comentario eliminado.');
      onChanged?.();
      void client.invalidateQueries({ queryKey: [...api.scopeKey, 'inbox'], exact: true });
      void query.refetch();
    });
  }

  return (
    <section className="tc-section" aria-labelledby={headingId}>
      <div className="tc-heading">
        <h4 id={headingId}>
          <MessageSquare size={16} aria-hidden="true" /> Comentarios
        </h4>
        <button
          type="button"
          className="ibtn ibtn-xs"
          aria-label="Actualizar comentarios"
          disabled={actionPending || query.isFetching}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {query.isPending && <Busy>Cargando conversación…</Busy>}
      {(error || query.error) && <ErrorNotice>{error ?? errorMessage(query.error)}</ErrorNotice>}
      {notice && (
        <p className="tc-notice" role="status">
          <Check size={14} aria-hidden="true" />
          {notice}
        </p>
      )}
      {blocked && <p className="muted">Actualiza la conversación para comprobar tu acceso.</p>}
      {available && (
        <>
          {query.hasNextPage && (
            <button
              type="button"
              className="btn btn-secondary btn-sm tc-previous"
              disabled={actionPending || query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              <ChevronUp size={14} aria-hidden="true" />
              {query.isFetchingNextPage ? 'Cargando…' : 'Ver anteriores'}
            </button>
          )}
          <div className="tc-thread" aria-label="Conversación de la tarea" ref={threadElement}>
            {rows.length === 0 && (
              <div className="tc-empty">
                <MessageSquare size={24} aria-hidden="true" />
                <p>Aún no hay comentarios</p>
                <span>Comparte una actualización o una pregunta sobre esta tarea.</span>
              </div>
            )}
            {rows.map(row => (
              <article
                key={row.id}
                className={`tc-comment${row.id === focusCommentId ? ' tc-search-target' : ''}`}
                tabIndex={row.id === focusCommentId ? -1 : undefined}
                data-comment-id={row.id}
                aria-label={`Comentario de ${row.author_name}`}
              >
                <IdentityAvatar name={row.author_name} decorative />
                <div className="tc-comment-body">
                  <div className="tc-who">
                    <strong>{row.author_name}</strong>
                    <time dateTime={row.created_at}>{dateLabel(row.created_at)}</time>
                    {row.version > 1 && <span className="tc-edited">Editado</span>}
                    <span className="tc-comment-actions">
                      {canParticipate && row.can_edit && (
                        <button
                          type="button"
                          className="ibtn ibtn-xs"
                          aria-label={`Editar comentario de ${row.author_name}`}
                          disabled={actionPending}
                          onClick={() => {
                            setAction({ kind: 'edit', row });
                            setEditBody(row.body);
                            setError(null);
                          }}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                      )}
                      {canMutate && row.can_delete && (
                        <button
                          type="button"
                          className="ibtn ibtn-xs btn-danger-ghost"
                          aria-label={`Eliminar comentario de ${row.author_name}`}
                          disabled={actionPending}
                          onClick={() => {
                            setAction({ kind: 'delete', row });
                            setError(null);
                          }}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  </div>
                  {action?.kind === 'edit' && action.row.id === row.id ? (
                    <form className="tc-edit" onSubmit={saveEdit}>
                      <label className="sr" htmlFor={`${headingId}-edit`}>
                        Editar comentario
                      </label>
                      <textarea
                        id={`${headingId}-edit`}
                        value={editBody}
                        onChange={event => setEditBody(event.target.value)}
                        disabled={actionPending || !writable}
                        rows={3}
                      />
                      {currentAction?.version !== action.row.version && (
                        <div className="pw-info">
                          El comentario cambió.{' '}
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={actionPending}
                            onClick={() => {
                              if (currentAction) {
                                setAction({ kind: 'edit', row: currentAction });
                                setEditBody(currentAction.body);
                              }
                            }}
                          >
                            Cargar versión actual
                          </button>
                        </div>
                      )}
                      {row.mentions.length > 0 && <p className="muted tc-edit-note">Las menciones originales se conservan; editar no envía nuevos avisos.</p>}
                      <div className="tc-edit-actions">
                        <button type="button" className="btn btn-secondary btn-sm" disabled={actionPending} onClick={() => setAction(null)}>
                          Cancelar edición
                        </button>
                        <button
                          type="submit"
                          className="btn btn-primary btn-sm"
                          disabled={
                            actionPending ||
                            !writable ||
                            !editBody.trim() ||
                            Array.from(editBody).length > COMMENT_MAX_LENGTH ||
                            currentAction?.version !== action.row.version
                          }
                        >
                          Guardar comentario
                        </button>
                      </div>
                    </form>
                  ) : (
                    <p className="tc-text">{row.body}</p>
                  )}
                  {row.mentions.length > 0 && (
                    <div className="tc-mentions" aria-label="Personas mencionadas">
                      {row.mentions.map(person => (
                        <span key={person.member_id} className="tc-mention">
                          @{person.display_name}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="tc-reactions">
                    {row.reactions.map(reaction => (
                      <button
                        type="button"
                        key={reaction.emoji}
                        className={`tc-reaction${reaction.mine ? ' mine' : ''}`}
                        aria-label={`${reaction.emoji} · ${reaction.count} ${reaction.count === 1 ? 'reacción' : 'reacciones'}`}
                        aria-pressed={reaction.mine}
                        disabled={!writable || actionPending}
                        onClick={() => react(row, reaction.emoji)}
                      >
                        <span aria-hidden="true">{reaction.emoji}</span>
                        {reaction.count}
                      </button>
                    ))}
                    {canParticipate && (
                      <button
                        type="button"
                        className="tc-add-reaction"
                        aria-label={`Reaccionar al comentario de ${row.author_name}`}
                        aria-expanded={reactionFor === row.id}
                        disabled={actionPending}
                        onClick={() => setReactionFor(previous => (previous === row.id ? null : row.id))}
                      >
                        <SmilePlus size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {reactionFor === row.id && canParticipate && (
                    <div
                      className="tc-reaction-picker"
                      aria-label="Elegir reacción"
                      onKeyDown={event => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setReactionFor(null);
                        }
                      }}
                    >
                      {COMMENT_REACTIONS.map(emoji => (
                        <button key={emoji} type="button" aria-label={`Reaccionar con ${emoji}`} disabled={actionPending} onClick={() => react(row, emoji)}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          {readOnly || task.archived_at || !canComment ? (
            <p className="tc-readonly">Puedes consultar la conversación. Para comentar necesitas acceso de edición y una tarea activa.</p>
          ) : (
            <form className="tc-composer" onSubmit={send}>
              <label className="sr" htmlFor={`${headingId}-body`}>
                Escribe un comentario
              </label>
              <textarea
                ref={textarea}
                id={`${headingId}-body`}
                placeholder="Escribe un comentario… Usa @ para mencionar"
                rows={3}
                value={body}
                disabled={actionPending || !writable || unconfirmed}
                onKeyDown={bodyKeys}
                onChange={event => {
                  const next = event.target.value;
                  setBody(next);
                  const match = /(?:^|\s)@([^\s@]*)$/.exec(next);
                  if (match && participants.length > 0) {
                    setPeopleQuery(match[1]);
                    setPicker(true);
                  } else setPicker(false);
                }}
              />
              {mentions.length > 0 && (
                <div className="tc-mentions" aria-label="Menciones del comentario">
                  {mentions.map(person => (
                    <span key={person.member_id} className="tc-mention">
                      @{person.display_name}
                      <button
                        type="button"
                        aria-label={`Quitar mención a ${person.display_name}`}
                        disabled={actionPending || unconfirmed}
                        onClick={() => setMentions(previous => previous.filter(row => row.member_id !== person.member_id))}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {picker && participants.length > 0 && (
                <div className="tc-people-picker">
                  <label className="tc-people-search">
                    <AtSign size={14} aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="Buscar personas para mencionar"
                      disabled={actionPending}
                      value={peopleQuery}
                      onChange={event => setPeopleQuery(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setPicker(false);
                          textarea.current?.focus();
                        }
                      }}
                    />
                  </label>
                  <div className="tc-people-list" aria-label="Personas disponibles para mencionar">
                    {people.length ? (
                      people.slice(0, 30).map(person => (
                        <button type="button" key={person.member_id} disabled={actionPending || mentions.length >= 10} onClick={() => choose(person)}>
                          <IdentityAvatar name={person.display_name} decorative />
                          <span>{person.display_name}</span>
                          <AtSign size={13} aria-hidden="true" />
                        </button>
                      ))
                    ) : (
                      <p className="muted">No hay más personas disponibles.</p>
                    )}
                  </div>
                </div>
              )}
              {unconfirmed && <p className="tc-send-warning">El envío no está confirmado. Reintenta este mismo comentario para evitar duplicados.</p>}
              <div className="tc-composer-footer">
                <button
                  type="button"
                  className="ibtn"
                  aria-label="Mencionar a una persona"
                  aria-expanded={picker}
                  disabled={actionPending || !participants.length || mentions.length >= 10 || unconfirmed}
                  onClick={() => {
                    setPeopleQuery('');
                    setPicker(previous => !previous);
                  }}
                >
                  <AtSign size={16} aria-hidden="true" />
                </button>
                <span className={bodyLength > COMMENT_MAX_LENGTH ? 'tc-over-limit' : 'muted'} aria-live={bodyLength > COMMENT_MAX_LENGTH ? 'polite' : 'off'}>
                  {bodyLength}/{COMMENT_MAX_LENGTH}
                </span>
                <span className="tc-shortcut">Ctrl / ⌘ + Enter</span>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={actionPending || !writable || !body.trim() || bodyLength > COMMENT_MAX_LENGTH}
                >
                  <Send size={14} aria-hidden="true" />
                  {busy ? 'Enviando…' : unconfirmed ? 'Reintentar envío' : 'Comentar'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {action?.kind === 'delete' && currentAction && canMutate && (
        <Dialog title="Eliminar comentario" onClose={() => setAction(null)} busy={actionPending}>
          <div className="pw-form-body">
            <p>Se eliminarán este comentario, sus reacciones y los avisos asociados. Las tareas y los demás comentarios se conservarán.</p>
            <blockquote className="tc-delete-preview">{currentAction.body}</blockquote>
          </div>
          <div className="pw-form-footer">
            <button type="button" className="btn btn-secondary" disabled={actionPending} onClick={() => setAction(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-danger" disabled={actionPending || !currentAction.can_delete} onClick={remove}>
              Eliminar comentario
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
