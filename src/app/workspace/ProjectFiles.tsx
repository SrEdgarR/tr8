import { useEffect, useId, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import {
  Archive,
  Check,
  Clock3,
  Download,
  Ellipsis,
  File,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List,
  LoaderCircle,
  Pencil,
  Presentation,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UploadCloud,
} from 'lucide-react';
import type { Project, WorkspaceProps } from '../types';
import { FILE_MAX_BYTES, PROJECT_FILE_ACCEPT, type ProjectFile, type ProjectFileList, type ProjectFilesApi } from '../project-files-types';
import { validateProjectFile, validateProjectFileName } from '../data/project-files';
import { canInProject, canInWorkspace } from './permissions';
import { Dialog, EmptyState, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import { FILE_KINDS, fileSize, projectFileKind, visibleProjectFiles, type FileKind, type FileSort } from './file-model';
import './project-files.css';

interface Props {
  focusFileId?: string | null;
  data: WorkspaceProps;
  project: Project;
  api: ProjectFilesApi;
}
type Attempt = { id: string; file: File | null; name: string; state: 'queued' | 'uploading' | 'done' | 'failed'; error?: string };
type FileAction = { type: 'detail' | 'rename' | 'delete'; row: ProjectFile };
const kindIcons = { image: ImageIcon, pdf: FileText, sheet: FileSpreadsheet, document: FileText, presentation: Presentation, archive: Archive, other: File };

export default function ProjectFiles(props: Props) {
  const { data, project, api } = props;
  const readable =
    !data.accessUnavailable &&
    !data.loading &&
    canInWorkspace(data, 'project.read') &&
    (!data.workspace || data.workspace.id === project.workspace_id) &&
    data.projects.some(row => row.id === project.id && row.workspace_id === project.workspace_id) &&
    (!data.capabilities || canInProject(data, project.id, 'project.read'));
  const writable = readable && !data.readOnly && !project.archived_at && canInProject(data, project.id, 'project.edit');
  const scope = JSON.stringify([data.currentUserId, project.workspace_id, project.id, api.scopeKey, readable, writable]);
  return <ScopedProjectFiles key={scope} {...props} readable={readable} writable={writable} />;
}

function ScopedProjectFiles({ data, project, api, readable, writable, focusFileId }: Props & { readable: boolean; writable: boolean }) {
  const client = useQueryClient();
  const queryKey = [...api.scopeKey, 'project-files', data.currentUserId ?? 'legacy', project.workspace_id, project.id];
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<FileKind | ''>('');
  const [sort, setSort] = useState<FileSort>('date');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const [action, setAction] = useState<FileAction | null>(null);
  const active = useRef(true);
  const locked = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const urls = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const openedSearchFile = useRef<string | null>(null);
  useEffect(() => {
    active.current = true;
    const createdUrls = urls.current;
    const createdTimers = timers.current;
    return () => {
      active.current = false;
      for (const url of createdUrls) URL.revokeObjectURL(url);
      for (const timer of createdTimers) clearTimeout(timer);
      createdUrls.clear();
      createdTimers.clear();
    };
  }, []);
  useEffect(() => {
    if (!menuId) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.pwf-menu-wrap,.pwf-menu')) setMenuId(null);
    };
    document.addEventListener('pointerdown', outside);
    const close = () => setMenuId(null);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
    };
  }, [menuId]);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await api.list(project, signal);
      if (!active.current || signal.aborted) throw new Error('El acceso cambió durante la consulta.');
      return result;
    },
    enabled: readable,
    staleTime: 15000,
    refetchOnMount: focusFileId ? 'always' : true,
    retry: false,
  });
  const available = readable && !!query.data && !query.error;
  const all = available ? query.data!.items.filter(row => row.workspace_id === project.workspace_id && row.project_id === project.id) : [];
  const rows = visibleProjectFiles(all, search, kind, sort);
  const blocked = busy || data.pending;
  const failed = attempts.filter(attempt => attempt.state === 'failed' && attempt.file);
  useEffect(() => {
    if (!focusFileId || !available || query.isFetching || openedSearchFile.current === focusFileId) return;
    openedSearchFile.current = focusFileId;
    const target = query.data!.items.find(row => row.id === focusFileId && row.project_id === project.id && row.workspace_id === project.workspace_id);
    if (target?.status === 'ready') setAction({ type: 'detail', row: target });
    else setNotice('El archivo ya no está disponible. Actualiza la búsqueda para comprobarlo.');
  }, [focusFileId, available, query.isFetching, query.data, project.id, project.workspace_id]);
  function assertActive() {
    if (!active.current) throw new Error('El espacio o tus permisos cambiaron. Comprueba el resultado al volver.');
  }
  function refresh() {
    setError(null);
    void query.refetch();
  }
  function accept(row: ProjectFile) {
    client.setQueryData<ProjectFileList>(queryKey, previous =>
      previous
        ? {
            ...previous,
            items: [...previous.items.filter(file => file.id !== row.id), row],
          }
        : previous,
    );
    void client.invalidateQueries({ queryKey, exact: true });
  }
  function author(row: ProjectFile) {
    if (row.created_by === data.currentUserId) return 'Tú';
    return canInWorkspace(data, 'member.read')
      ? (data.members?.find(member => member.user_id === row.created_by && member.status === 'active')?.display_name ?? 'Miembro')
      : 'Miembro';
  }
  async function uploadBatch(batch: Attempt[]) {
    if (!writable || !available || locked.current || data.pending || !batch.length) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    for (const attempt of batch) {
      if (!active.current || !attempt.file) break;
      setAttempts(previous => previous.map(row => (row.id === attempt.id ? { ...row, state: 'uploading', error: undefined } : row)));
      try {
        validateProjectFile(attempt.file);
        const saved = await api.upload(project, attempt.file, attempt.id);
        assertActive();
        if (saved.status !== 'ready') throw new Error('La carga todavía no está confirmada. Reintenta para completarla.');
        accept(saved);
        setAttempts(previous => previous.map(row => (row.id === attempt.id ? { ...row, state: 'done', file: null, error: undefined } : row)));
      } catch (cause) {
        if (active.current) {
          setAttempts(previous => previous.map(row => (row.id === attempt.id ? { ...row, state: 'failed', error: errorMessage(cause) } : row)));
          void client.invalidateQueries({ queryKey, exact: true });
        }
      }
    }
    locked.current = false;
    if (active.current) setBusy(false);
  }
  function selectFiles(files: File[]) {
    if (!writable || !available || blocked || locked.current || query.isFetching) return;
    const retained = attempts.filter(attempt => attempt.state !== 'done' && attempt.file);
    if (files.length > 10 || retained.length + files.length > 10) {
      setError('Selecciona hasta 10 archivos por lote. Resuelve las cargas pendientes antes de añadir más.');
      return;
    }
    const next = files.map(file => {
      const attempt: Attempt = { id: crypto.randomUUID(), file, name: file.name, state: 'queued' };
      try {
        validateProjectFile(file);
      } catch (cause) {
        attempt.state = 'failed';
        attempt.error = errorMessage(cause);
        attempt.file = null;
      }
      return attempt;
    });
    const valid = next.filter(attempt => attempt.state === 'queued');
    let confirmedBytes = 0;
    const admissionBytes = valid.reduce((peak, attempt) => {
      const nextPeak = Math.max(peak, confirmedBytes + FILE_MAX_BYTES);
      confirmedBytes += attempt.file!.size;
      return nextPeak;
    }, 0);
    if (all.length + valid.length > query.data!.max_files || query.data!.used_bytes + admissionBytes > query.data!.max_bytes) {
      setError('Este lote supera el almacenamiento o la cantidad de archivos disponible en el proyecto. Retira cargas que no necesites o elige un lote menor.');
      return;
    }
    setAttempts([...retained, ...next]);
    setError(null);
    void uploadBatch(next.filter(attempt => attempt.state === 'queued'));
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    if (!blocked && writable) selectFiles(Array.from(event.dataTransfer.files));
  }
  async function download(row: ProjectFile) {
    if (!available || row.status !== 'ready' || locked.current || data.pending) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setMenuId(null);
    try {
      const blob = await api.download(row);
      assertActive();
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = row.name;
      document.body.append(link);
      link.click();
      link.remove();
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        timers.current.delete(timer);
      }, 1000);
      timers.current.add(timer);
      setNotice(`Descarga preparada: ${row.name}.`);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function rename(name: string) {
    if (!action || action.type !== 'rename' || !writable || !available || blocked || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.rename(action.row, validateProjectFileName(name, action.row.content_type));
      assertActive();
      accept(saved);
      setAction(null);
      setNotice('Nombre del archivo actualizado.');
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function remove() {
    if (!action || action.type !== 'delete' || !writable || !available || blocked || locked.current) return;
    const row = action.row;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.remove(row);
      assertActive();
      client.setQueryData<ProjectFileList>(queryKey, previous =>
        previous
          ? {
              ...previous,
              items: previous.items.filter(file => file.id !== row.id),
            }
          : previous,
      );
      void client.invalidateQueries({ queryKey, exact: true });
      setAttempts(previous => previous.filter(attempt => attempt.id !== row.id));
      setAction(null);
      setNotice('Archivo retirado. Tus proyectos y tareas se conservaron.');
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  function openAction(type: FileAction['type'], row: ProjectFile) {
    if (menuId) trigger.current?.focus();
    setMenuId(null);
    setError(null);
    setNotice(null);
    setAction({ type, row });
  }
  function closeAction() {
    if (!busy) {
      setAction(null);
      for (const url of urls.current) URL.revokeObjectURL(url);
      for (const timer of timers.current) clearTimeout(timer);
      urls.current.clear();
      timers.current.clear();
    }
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuId(null);
      trigger.current?.focus();
      return;
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowDown'
        ? (current + 1) % buttons.length
        : event.key === 'ArrowUp'
          ? (current + buttons.length - 1) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : -1;
    if (next >= 0) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  }
  function options(row: ProjectFile) {
    return (
      <div className="pwf-menu-wrap">
        <button
          type="button"
          className="ibtn ibtn-xs"
          aria-label={`Opciones de ${row.name}`}
          aria-expanded={menuId === row.id}
          aria-haspopup="menu"
          disabled={blocked}
          onClick={event => {
            trigger.current = event.currentTarget;
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenuPosition({
              left: Math.max(8, Math.min(bounds.right - 180, window.innerWidth - 188)),
              top: Math.max(8, bounds.bottom + 165 < window.innerHeight ? bounds.bottom + 5 : bounds.top - 160),
            });
            setMenuId(menuId === row.id ? null : row.id);
          }}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
        {menuId === row.id &&
          createPortal(
            <div className="pwf-menu" style={menuPosition} role="menu" aria-label={`Acciones de ${row.name}`} ref={menu} onKeyDown={menuKeys}>
              <button type="button" role="menuitem" onClick={() => openAction('detail', row)}>
                <FolderOpen size={14} aria-hidden="true" /> Ver detalles
              </button>
              {row.status === 'ready' && (
                <button type="button" role="menuitem" onClick={() => void download(row)}>
                  <Download size={14} aria-hidden="true" /> Descargar
                </button>
              )}
              {writable && row.status === 'ready' && (
                <button type="button" role="menuitem" onClick={() => openAction('rename', row)}>
                  <Pencil size={14} aria-hidden="true" /> Cambiar nombre
                </button>
              )}
              {writable && (
                <button type="button" role="menuitem" className="pwf-danger" onClick={() => openAction('delete', row)}>
                  <Trash2 size={14} aria-hidden="true" /> {row.status === 'ready' ? 'Eliminar archivo' : 'Retirar carga'}
                </button>
              )}
            </div>,
            document.body,
          )}
      </div>
    );
  }

  if (!readable) return <EmptyState title="Archivos no disponibles">No tienes acceso a los archivos de este proyecto.</EmptyState>;
  return (
    <section className="pwf-page" aria-label={`Archivos de ${project.name}`}>
      <div className="pwf-toolbar">
        <label className="pwf-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="Buscar archivos"
            type="search"
            placeholder="Buscar archivos…"
            value={search}
            maxLength={240}
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        <select aria-label="Tipo de archivo" value={kind} onChange={event => setKind(event.target.value as FileKind | '')}>
          <option value="">Todos los tipos</option>
          {Object.entries(FILE_KINDS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
        <select aria-label="Orden de archivos" value={sort} onChange={event => setSort(event.target.value as FileSort)}>
          <option value="date">Más recientes</option>
          <option value="name">Nombre</option>
          <option value="type">Tipo</option>
        </select>
        <span className="sp" />
        <div className="pwf-view" role="group" aria-label="Vista de archivos">
          <button type="button" aria-label="Cuadrícula de archivos" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
            <LayoutGrid size={15} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Lista de archivos" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            <List size={15} aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="ibtn" aria-label="Actualizar archivos" disabled={blocked || query.isFetching} onClick={refresh}>
          <RefreshCw size={15} className={query.isFetching ? 'pw-spin' : ''} aria-hidden="true" />
        </button>
        {writable && (
          <button type="button" className="btn btn-primary btn-sm" disabled={blocked || !available || query.isFetching} onClick={() => input.current?.click()}>
            <Upload size={14} aria-hidden="true" />
            Subir archivos
          </button>
        )}
      </div>
      <input
        ref={input}
        className="sr"
        tabIndex={-1}
        aria-label="Seleccionar archivos"
        type="file"
        multiple
        accept={PROJECT_FILE_ACCEPT}
        disabled={blocked || !writable || !available || query.isFetching}
        onChange={event => {
          selectFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      {writable && (
        <button
          type="button"
          className={`pwf-dropzone${over ? ' is-over' : ''}`}
          disabled={blocked || !available || query.isFetching}
          onDragOver={event => {
            event.preventDefault();
            if (!blocked && available && !query.isFetching) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          onClick={() => input.current?.click()}
        >
          <UploadCloud size={23} aria-hidden="true" />
          <span>
            <strong>Arrastra archivos aquí o elige desde tu dispositivo</strong>
            <small>Hasta {fileSize(query.data?.max_file_bytes ?? FILE_MAX_BYTES)} por archivo · Máximo 10 por lote</small>
            <small>Necesitas 5 MiB libres para iniciar una carga; al confirmarse cuenta su tamaño real.</small>
          </span>
        </button>
      )}
      {!writable && (
        <p className="pwf-readonly">
          {project.archived_at
            ? 'Proyecto archivado. Puedes consultar y descargar sus archivos.'
            : 'Puedes consultar y descargar los archivos de este proyecto.'}
        </p>
      )}
      {query.isPending && (
        <div className="pwf-loading" role="status">
          <LoaderCircle size={18} className="pw-spin" aria-hidden="true" />
          Cargando archivos…
        </div>
      )}
      {(error || query.error) && !action && <ErrorNotice>{error ?? errorMessage(query.error)}</ErrorNotice>}
      {notice && (
        <p className="pwf-notice" role="status">
          <Check size={14} aria-hidden="true" />
          {notice}
        </p>
      )}
      {available && (
        <div className="pwf-summary">
          {query.isFetching ? (
            <span>Actualizando almacenamiento del proyecto…</span>
          ) : (
            <span>
              Almacenamiento del proyecto: {all.length} {all.length === 1 ? 'archivo' : 'archivos'} · {fileSize(query.data!.used_bytes)} de{' '}
              {fileSize(query.data!.max_bytes)}
            </span>
          )}
          <span>{query.data!.max_files} archivos como máximo</span>
        </div>
      )}
      {attempts.length > 0 && (
        <div className="pwf-uploads" aria-label="Cargas de archivos" aria-live="polite">
          {attempts.map(attempt => (
            <div key={attempt.id} className={`pwf-upload is-${attempt.state}`}>
              <span className="pwf-upload-icon">
                {attempt.state === 'uploading' ? (
                  <LoaderCircle size={16} className="pw-spin" aria-hidden="true" />
                ) : attempt.state === 'done' ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <Upload size={16} aria-hidden="true" />
                )}
              </span>
              <div>
                <strong>{attempt.name}</strong>
                <small>
                  {attempt.state === 'uploading'
                    ? 'Subiendo y confirmando…'
                    : attempt.state === 'queued'
                      ? 'En espera'
                      : attempt.state === 'done'
                        ? 'Guardado'
                        : attempt.error}
                </small>
              </div>
              {attempt.state === 'failed' && attempt.file && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={blocked || !available} onClick={() => void uploadBatch([attempt])}>
                  Reintentar
                </button>
              )}
            </div>
          ))}
          {failed.length > 1 && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={blocked || !available} onClick={() => void uploadBatch(failed)}>
              Reintentar cargas pendientes
            </button>
          )}
        </div>
      )}
      {available && !rows.length && (
        <EmptyState
          title={search || kind ? 'No encontramos esos archivos' : 'Todavía no hay archivos'}
          action={
            search || kind ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSearch('');
                  setKind('');
                }}
              >
                Limpiar filtros
              </button>
            ) : undefined
          }
        >
          {search || kind ? 'Prueba con otro nombre o tipo de archivo.' : 'Guarda documentos, imágenes y recursos del proyecto en este espacio.'}
        </EmptyState>
      )}
      {available &&
        rows.length > 0 &&
        (view === 'grid' ? (
          <div className="pwf-grid">
            {rows.map(row => {
              const type = projectFileKind(row),
                info = FILE_KINDS[type],
                Icon = kindIcons[type];
              return (
                <article key={row.id} className="pwf-card" style={{ '--pwf-color': info.color } as CSSProperties}>
                  <button type="button" className="pwf-preview" aria-label={`Ver detalles de ${row.name}`} onClick={() => openAction('detail', row)}>
                    <span className="pwf-paper">
                      <Icon size={34} strokeWidth={1.3} aria-hidden="true" />
                    </span>
                    <span className="pwf-extension">{row.name.split('.').at(-1)?.slice(0, 8)}</span>
                  </button>
                  <div className="pwf-card-body">
                    <button type="button" className="pwf-file-name" onClick={() => openAction('detail', row)} title={row.name}>
                      {row.name}
                    </button>
                    <span>
                      {fileSize(row.size)} · {author(row)}
                    </span>
                    <span>{displayDate(row.created_at)}</span>
                    <FileStatus row={row} />
                  </div>
                  {options(row)}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="pwf-table-wrap">
            <table className="pwf-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Tipo</th>
                  <th>Tamaño</th>
                  <th>Subido por</th>
                  <th>Fecha</th>
                  <th>
                    <span className="sr">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const type = projectFileKind(row),
                    info = FILE_KINDS[type],
                    Icon = kindIcons[type];
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="pwf-table-name">
                          <span className="pwf-type-icon" style={{ '--pwf-color': info.color } as CSSProperties}>
                            <Icon size={16} aria-hidden="true" />
                          </span>
                          <div>
                            <button type="button" className="pwf-file-name" onClick={() => openAction('detail', row)}>
                              {row.name}
                            </button>
                            <FileStatus row={row} />
                          </div>
                        </div>
                      </td>
                      <td>{info.singular}</td>
                      <td>{fileSize(row.size)}</td>
                      <td>{author(row)}</td>
                      <td>{displayDate(row.created_at)}</td>
                      <td>{options(row)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      {action?.type === 'detail' && (
        <Dialog title={action.row.name} onClose={closeAction} busy={busy}>
          <div className="pw-form-body pwf-detail">
            <FileBadge row={action.row} />
            <dl>
              <dt>Tipo</dt>
              <dd>{FILE_KINDS[projectFileKind(action.row)].singular}</dd>
              <dt>Tamaño</dt>
              <dd>{fileSize(action.row.size)}</dd>
              <dt>Subido por</dt>
              <dd>{author(action.row)}</dd>
              <dt>Fecha</dt>
              <dd>{displayDate(action.row.created_at)}</dd>
            </dl>
            <FileStatus row={action.row} />
            <p className="muted">Descarga el archivo para abrirlo en tu dispositivo.</p>
            {error && <ErrorNotice>{error}</ErrorNotice>}
          </div>
          <div className="pw-form-footer">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={closeAction}>
              Cerrar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={blocked || action.row.status !== 'ready' || !available}
              onClick={() => void download(action.row)}
            >
              <Download size={14} aria-hidden="true" />
              Descargar archivo
            </button>
          </div>
        </Dialog>
      )}
      {action?.type === 'rename' && (
        <RenameFile
          key={action.row.id}
          row={action.row}
          busy={blocked}
          canSubmit={available && writable}
          error={error}
          onClose={closeAction}
          onSubmit={rename}
        />
      )}
      {action?.type === 'delete' && (
        <DeleteFile
          key={action.row.id}
          row={action.row}
          busy={blocked}
          canSubmit={available && writable}
          error={error}
          onClose={closeAction}
          onSubmit={remove}
        />
      )}
    </section>
  );
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}
function FileStatus({ row }: { row: ProjectFile }) {
  return row.status === 'ready' ? null : (
    <span className="pwf-file-status">
      <Clock3 size={12} aria-hidden="true" />
      {row.status === 'pending' ? 'Carga pendiente de confirmar' : 'Retirada pendiente'}
    </span>
  );
}
function FileBadge({ row }: { row: ProjectFile }) {
  const type = projectFileKind(row),
    Icon = kindIcons[type];
  return (
    <span className="pwf-detail-icon" style={{ '--pwf-color': FILE_KINDS[type].color } as CSSProperties}>
      <Icon size={38} strokeWidth={1.2} aria-hidden="true" />
    </span>
  );
}
function RenameFile({
  row,
  busy,
  canSubmit,
  error,
  onClose,
  onSubmit,
}: {
  row: ProjectFile;
  busy: boolean;
  canSubmit: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(row.name);
  const id = useId();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && canSubmit) void onSubmit(name);
  }
  return (
    <Dialog title="Cambiar nombre del archivo" onClose={onClose} busy={busy}>
      <form className="pw-form" onSubmit={submit}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <label className="pw-field" htmlFor={id}>
            Nombre del archivo
            <span className="pwf-input">
              <FileText size={15} aria-hidden="true" />
              <input
                id={id}
                value={name}
                maxLength={180}
                disabled={busy}
                required
                data-initial-focus
                onChange={event => setName(event.target.value)}
                autoComplete="off"
              />
            </span>
          </label>
          <p className="muted">Conserva la extensión que corresponde al contenido del archivo.</p>
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !canSubmit || !name.trim()} type="submit">
            <Pencil size={14} aria-hidden="true" />
            {busy ? 'Guardando…' : 'Guardar nombre'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function DeleteFile({
  row,
  busy,
  canSubmit,
  error,
  onClose,
  onSubmit,
}: {
  row: ProjectFile;
  busy: boolean;
  canSubmit: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const id = useId();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && canSubmit && confirmation === row.name) void onSubmit();
  }
  return (
    <Dialog title={row.status === 'ready' ? 'Eliminar archivo' : 'Retirar carga'} onClose={onClose} busy={busy}>
      <form className="pw-form" onSubmit={submit}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <p>
            Se retirará únicamente <strong>{row.name}</strong> de este proyecto. Sus tareas y los demás archivos se conservarán.
          </p>
          <p className="muted">Esta acción no se puede deshacer.</p>
          <label className="pw-field" htmlFor={id}>
            Escribe el nombre exacto del archivo
            <input
              id={id}
              value={confirmation}
              disabled={busy}
              onChange={event => setConfirmation(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" data-initial-focus disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-danger" disabled={busy || !canSubmit || confirmation !== row.name} type="submit">
            <Trash2 size={14} aria-hidden="true" />
            {busy ? 'Retirando…' : row.status === 'ready' ? 'Eliminar archivo definitivamente' : 'Retirar esta carga'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
