import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronDown, Eye, Pencil, Pin, PinOff, Plus, RotateCw, Search, StickyNote, Tag, Trash2, X } from 'lucide-react';
import { DataError } from '../data/errors';
import {
  NOTE_BODY_LIMIT,
  NOTE_PAGE_SIZE,
  NOTE_QUERY_LIMIT,
  NOTE_TAG_LENGTH_LIMIT,
  NOTE_TAG_LIMIT,
  NOTE_TITLE_LIMIT,
  type Note,
  type NoteContent,
  type NotesApi,
} from '../notes-types';
import { errorMessage } from './helpers';
import { Busy, Dialog, ErrorNotice } from './ui';
import './notes.css';

type Props = { api: NotesApi; projectId: string | null; scopeLabel: string; canCreate: boolean };
type Action = { kind: 'new'; id: string } | { kind: 'open' | 'delete'; note: Note };

const noteDate = new Intl.DateTimeFormat('es', { dateStyle: 'medium' });

function denied(error: unknown) {
  return error instanceof DataError && ['PT404', '42501', 'PGRST301', 'PGRST303'].includes(error.code ?? '');
}

function noteText(value: string, limit: number) {
  return value.length <= limit ? value : Array.from(value).slice(0, limit).join('');
}

function Tags({ tags }: { tags: string[] }) {
  return (
    tags.length > 0 && (
      <ul className="tn-tags" aria-label="Etiquetas">
        {tags.map((tag, index) => (
          <li key={`${index}-${tag}`}>
            <Tag size={12} aria-hidden="true" />
            {tag}
          </li>
        ))}
      </ul>
    )
  );
}

export default function NotesPage(props: Props) {
  const { api, projectId, scopeLabel } = props;
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [queryText, setQueryText] = useState('');
  useEffect(() => {
    const timeout = window.setTimeout(() => setQueryText(search.trim()), 220);
    return () => window.clearTimeout(timeout);
  }, [search]);
  const scopeKey = [...api.scopeKey, projectId];
  const query = useInfiniteQuery({
    queryKey: [...scopeKey, archived, queryText],
    queryFn: ({ pageParam, signal }) => api.list(projectId, { archived, query: queryText, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (page, _, offset) => (page.has_more ? offset + NOTE_PAGE_SIZE : undefined),
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
  });
  const searching = queryText !== search.trim();
  const rows = query.error || searching ? [] : [...new Map(query.data?.pages.flatMap(page => page.notes.map(note => [note.id, note] as const))).values()];

  return (
    <section className="tn-page" aria-label={`Notas · ${scopeLabel}`}>
      <header className="tn-heading">
        <span className="tn-heading-icon">
          <StickyNote size={20} aria-hidden="true" />
        </span>
        <div>
          {projectId ? <h2>Notas</h2> : <h1>Notas</h1>}
          <p>{scopeLabel}</p>
        </div>
      </header>
      <div className="tn-toolbar">
        <div className="tn-segments" role="group" aria-label="Estado de las notas">
          <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>
            <StickyNote size={15} aria-hidden="true" /> Activas
          </button>
          <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>
            <Archive size={15} aria-hidden="true" /> Archivadas
          </button>
        </div>
        <label className="tn-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder="Buscar notas…"
            aria-label="Buscar notas"
            onChange={event => setSearch(noteText(event.target.value, NOTE_QUERY_LIMIT))}
          />
        </label>
      </div>
      {query.error && (
        <div className="tn-list-error">
          <ErrorNotice>{errorMessage(query.error)}</ErrorNotice>
          <button type="button" className="btn btn-secondary" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RotateCw size={14} aria-hidden="true" /> Reintentar
          </button>
        </div>
      )}
      {!denied(query.error) && (
        <NotesContent
          {...props}
          queryKey={scopeKey}
          rows={rows}
          archived={archived}
          searching={searching || query.isPending}
          filtered={!!queryText}
          available={query.isSuccess && !searching}
          loadingMore={query.isFetchingNextPage}
          onMore={query.hasNextPage ? () => void query.fetchNextPage() : undefined}
          onShowActive={() => {
            setArchived(false);
            setSearch('');
            setQueryText('');
          }}
        />
      )}
    </section>
  );
}

function NotesContent({
  api,
  projectId,
  canCreate,
  rows,
  archived,
  searching,
  filtered,
  available,
  loadingMore,
  queryKey,
  onMore,
  onShowActive,
}: Props & {
  rows: Note[];
  archived: boolean;
  searching: boolean;
  filtered: boolean;
  available: boolean;
  loadingMore: boolean;
  queryKey: readonly unknown[];
  onMore?: () => void;
  onShowActive: () => void;
}) {
  const client = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function open(next: Action | null) {
    if (locked.current) return;
    setError(null);
    setNotice(null);
    setAction(next);
  }

  async function run(operation: () => Promise<unknown>, message: string, afterSave?: () => void) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      if (!active.current) return;
      setAction(null);
      afterSave?.();
      setNotice(message);
      await client.invalidateQueries({ queryKey });
    } catch (cause) {
      if (!active.current) return;
      if (denied(cause)) setAction(null);
      const conflicted = cause instanceof DataError && cause.code === 'PT409';
      setError(
        conflicted && action && action.kind !== 'delete'
          ? 'La nota cambió en otro lugar o ya se guardó. Conservamos tu borrador. Puedes copiarlo antes de cerrar y revisar la nota actual.'
          : errorMessage(cause),
      );
      if (conflicted || denied(cause)) void client.invalidateQueries({ queryKey });
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <>
      {canCreate && (
        <button type="button" className="btn btn-primary tn-new" disabled={!available || busy} onClick={() => open({ kind: 'new', id: crypto.randomUUID() })}>
          <Plus size={16} aria-hidden="true" /> Nueva nota
        </button>
      )}
      {error && !action && <ErrorNotice>{error}</ErrorNotice>}
      {notice && (
        <p className="tn-notice" role="status">
          {notice}
        </p>
      )}
      {searching && <Busy>Buscando notas…</Busy>}
      {available && rows.length === 0 && (
        <div className="tn-empty">
          <StickyNote size={25} aria-hidden="true" />
          <h3>{filtered ? 'Sin resultados' : archived ? 'Sin notas archivadas' : 'Todavía no hay notas'}</h3>
          <p>
            {filtered
              ? 'Prueba con otro título, contenido o etiqueta.'
              : archived
                ? 'Las notas que archives aparecerán aquí.'
                : 'Este espacio está listo para tus ideas y apuntes.'}
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <div className="tn-grid">
          {rows.map(note => (
            <NoteCard
              key={note.id}
              note={note}
              writable={canCreate && note.can_edit}
              busy={busy}
              onOpen={() => open({ kind: 'open', note })}
              onPin={() =>
                void run(
                  () => api.update(projectId, note, { ...note, pinned: !note.pinned, archived: false }),
                  note.pinned ? 'Nota desfijada.' : 'Nota fijada.',
                )
              }
              onArchive={() =>
                void run(() => api.update(projectId, note, { ...note, archived: !note.archived_at }), note.archived_at ? 'Nota restaurada.' : 'Nota archivada.')
              }
              onRemove={() => open({ kind: 'delete', note })}
            />
          ))}
        </div>
      )}
      {available && onMore && (
        <button type="button" className="btn btn-secondary tn-more" disabled={loadingMore || busy} onClick={onMore}>
          <ChevronDown size={15} aria-hidden="true" /> {loadingMore ? 'Cargando…' : 'Cargar más notas'}
        </button>
      )}
      {canCreate && action?.kind === 'delete' && (
        <DeleteNote
          note={action.note}
          busy={busy}
          error={error}
          onClose={() => open(null)}
          onConfirm={() => void run(() => api.remove(projectId, action.note), 'Nota eliminada.')}
        />
      )}
      {action && (action.kind === 'open' || (action.kind === 'new' && canCreate)) && (
        <NoteEditor
          key={action.kind === 'new' ? action.id : action.note.id}
          note={action.kind === 'open' ? action.note : undefined}
          writable={canCreate}
          busy={busy}
          error={error}
          onClose={() => open(null)}
          onSave={draft => {
            if (action.kind === 'new') void run(() => api.create(projectId, action.id, draft), 'Nota creada.', onShowActive);
            else {
              const note = action.note;
              void run(() => api.update(projectId, note, { ...draft, pinned: note.pinned, archived: false }), 'Nota guardada.');
            }
          }}
        />
      )}
    </>
  );
}

function NoteCard({
  note,
  writable,
  busy,
  onOpen,
  onPin,
  onArchive,
  onRemove,
}: {
  note: Note;
  writable: boolean;
  busy: boolean;
  onOpen: () => void;
  onPin: () => void;
  onArchive: () => void;
  onRemove: () => void;
}) {
  const pinLabel = note.pinned ? 'Desfijar nota' : 'Fijar nota';
  const archiveLabel = note.archived_at ? 'Restaurar nota' : 'Archivar nota';
  return (
    <article className="tn-card">
      <button type="button" className="tn-card-open" onClick={onOpen} disabled={busy} aria-label={`Abrir nota ${note.title}`}>
        <span className="tn-card-title">
          {note.pinned && !note.archived_at && <Pin size={14} className="tn-pinned" aria-label="Fijada" />}
          <strong>{note.title}</strong>
        </span>
        {note.body && <span className="tn-excerpt">{note.body.slice(0, 400)}</span>}
      </button>
      <Tags tags={note.tags} />
      <footer className="tn-card-footer">
        <time dateTime={note.updated_at} title="Última actualización">
          {noteDate.format(new Date(note.updated_at))}
        </time>
        {writable && (
          <div className="tn-card-actions">
            {!note.archived_at && (
              <button type="button" className="ibtn" aria-label={`${pinLabel} ${note.title}`} title={pinLabel} disabled={busy} onClick={onPin}>
                {note.pinned ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}
              </button>
            )}
            <button type="button" className="ibtn" aria-label={`${archiveLabel} ${note.title}`} title={archiveLabel} disabled={busy} onClick={onArchive}>
              {note.archived_at ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}
            </button>
            {note.archived_at && (
              <button
                type="button"
                className="ibtn btn-danger-ghost"
                aria-label={`Eliminar nota ${note.title}`}
                title="Eliminar nota"
                disabled={busy}
                onClick={onRemove}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </footer>
    </article>
  );
}

function NoteEditor({
  note,
  writable,
  busy,
  error,
  onClose,
  onSave,
}: {
  note?: Note;
  writable: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (draft: NoteContent) => void;
}) {
  const canEdit = writable && (!note || (note.can_edit && !note.archived_at));
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [tags, setTags] = useState(note?.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [preview, setPreview] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const tagField = useRef<HTMLInputElement>(null);
  const originalTags = note?.tags ?? [];
  const nextTag = tagInput.trim();
  const draftTags = nextTag && !tags.includes(nextTag) ? [...tags, nextTag] : tags;
  const dirty =
    title !== (note?.title ?? '') ||
    body !== (note?.body ?? '') ||
    draftTags.length !== originalTags.length ||
    draftTags.some((tag, index) => tag !== originalTags[index]);

  useEffect(() => {
    if (discard) keepEditing.current?.focus();
  }, [discard]);

  function close() {
    if (canEdit && dirty) setDiscard(true);
    else onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || busy || discard || !dirty) return;
    if (!title.trim()) {
      setPreview(false);
      setFieldError('Escribe un título para la nota.');
      return;
    }
    if (draftTags.length > NOTE_TAG_LIMIT || draftTags.some(tag => [...tag].length > NOTE_TAG_LENGTH_LIMIT)) {
      setPreview(false);
      setFieldError(`Usa hasta ${NOTE_TAG_LIMIT} etiquetas de ${NOTE_TAG_LENGTH_LIMIT} caracteres cada una.`);
      return;
    }
    setFieldError(null);
    onSave({ title: title.trim(), body, tags: draftTags });
  }

  function addTag() {
    if (!nextTag || draftTags.length > NOTE_TAG_LIMIT || [...nextTag].length > NOTE_TAG_LENGTH_LIMIT) return;
    setTags(draftTags);
    setTagInput('');
    setFieldError(null);
    tagField.current?.focus();
  }

  return (
    <Dialog title={canEdit ? (note ? 'Editar nota' : 'Nueva nota') : 'Ver nota'} wide busy={busy} onClose={close}>
      <form className="pw-form" onSubmit={submit}>
        <div className="pw-form-body tn-editor">
          {canEdit && (
            <div className="tn-segments" role="group" aria-label="Modo de la nota">
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                <Pencil size={14} aria-hidden="true" /> Editar
              </button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                <Eye size={15} aria-hidden="true" /> Vista previa
              </button>
            </div>
          )}
          {canEdit && !preview ? (
            <>
              <label className="pw-field">
                Título
                <input
                  value={title}
                  onChange={event => setTitle(noteText(event.target.value, NOTE_TITLE_LIMIT))}
                  placeholder="Ej. Ideas para esta semana"
                  data-initial-focus
                  disabled={busy}
                  required
                />
              </label>
              <label className="pw-field tn-body-field">
                Contenido
                <textarea
                  value={body}
                  onChange={event => setBody(noteText(event.target.value, NOTE_BODY_LIMIT))}
                  placeholder="Escribe tus apuntes…"
                  disabled={busy}
                />
              </label>
              <div className="tn-tag-field">
                <label className="pw-field">
                  Etiquetas{' '}
                  <small className="tn-hint">
                    {tags.length}/{NOTE_TAG_LIMIT}
                  </small>
                  <input
                    ref={tagField}
                    value={tagInput}
                    onChange={event => setTagInput(noteText(event.target.value, NOTE_TAG_LENGTH_LIMIT))}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      addTag();
                    }}
                    placeholder="Escribe una etiqueta"
                    disabled={busy || tags.length >= NOTE_TAG_LIMIT}
                  />
                </label>
                <button type="button" className="btn btn-secondary" onClick={addTag} disabled={busy || !nextTag || tags.length >= NOTE_TAG_LIMIT}>
                  <Plus size={15} aria-hidden="true" /> Añadir
                </button>
              </div>
              {tags.length > 0 && (
                <ul className="tn-tags" aria-label="Etiquetas de la nota">
                  {tags.map((tag, index) => (
                    <li key={`${index}-${tag}`}>
                      <Tag size={12} aria-hidden="true" /> {tag}
                      <button
                        type="button"
                        className="ibtn ibtn-xs"
                        onClick={() => setTags(tags.filter((_, tagIndex) => tagIndex !== index))}
                        disabled={busy}
                        aria-label={`Quitar etiqueta ${tag}`}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="tn-preview">
              <h3>{title.trim() || 'Sin título'}</h3>
              <p>{body.trim() ? body : 'Sin contenido.'}</p>
              <Tags tags={draftTags} />
            </div>
          )}
          {discard && (
            <p className="tn-discard" role="alert">
              Tienes cambios sin guardar. Puedes seguir editando o descartar el borrador.
            </p>
          )}
          {(error || fieldError) && <ErrorNotice>{fieldError ?? error}</ErrorNotice>}
        </div>
        <div className="pw-form-footer">
          {discard ? (
            <>
              <button ref={keepEditing} type="button" className="btn btn-secondary" onClick={() => setDiscard(false)}>
                Seguir editando
              </button>
              <button type="button" className="btn btn-danger" onClick={onClose}>
                Descartar cambios
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
                {canEdit ? 'Cancelar' : 'Cerrar'}
              </button>
              {canEdit && (
                <button type="submit" className="btn btn-primary" disabled={busy || !dirty || !title.trim()}>
                  {busy ? 'Guardando…' : 'Guardar nota'}
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function DeleteNote({
  note,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  note: Note;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  return (
    <Dialog title="Eliminar nota" busy={busy} onClose={onClose}>
      <form
        className="pw-form"
        onSubmit={event => {
          event.preventDefault();
          if (!busy && confirmation === 'ELIMINAR') onConfirm();
        }}
      >
        <div className="pw-form-body">
          <p>
            Eliminarás definitivamente <strong>{note.title}</strong>.
          </p>
          <label className="pw-field">
            Escribe ELIMINAR para confirmar
            <input autoComplete="off" data-initial-focus value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} />
          </label>
          {error && <ErrorNotice>{error}</ErrorNotice>}
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy || confirmation !== 'ELIMINAR'}>
            {busy ? 'Eliminando…' : 'Eliminar definitivamente'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
