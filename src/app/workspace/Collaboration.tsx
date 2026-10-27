import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import type { CollaborationApi, Project, WorkspaceMember, WorkspaceProps, WorkspaceRole } from '../types';
import { Busy, Dialog, EmptyState, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import { canInWorkspace, PERMISSIONS } from './permissions';
import TeamSummary from './TeamSummary';

const ACTION_NAMES: Record<string, string> = {
  'role.created': 'Creó un rol',
  'role.updated': 'Actualizó un rol',
  'role.deleted': 'Eliminó un rol',
  'member.roles_changed': 'Cambió roles de un miembro',
  'member.removed': 'Retiró un miembro',
  'project.access_changed': 'Cambió el acceso a un proyecto',
  'project.access_removed': 'Retiró acceso a un proyecto',
  'task.assigned': 'Cambió el responsable de una tarea',
  'task.unassigned': 'Retiró el responsable de una tarea',
  'project.created': 'Creó un proyecto',
  'project.updated': 'Actualizó un proyecto',
  'project.deleted': 'Eliminó un proyecto',
  'task.created': 'Creó una tarea',
  'task.updated': 'Actualizó una tarea',
  'task.scheduled': 'Cambió el bloque horario de una tarea',
  'task.deleted': 'Eliminó una tarea',
};

export function ActivityPanel({
  api,
  projectId = null,
  compact = false,
  title = 'Actividad',
}: {
  api: CollaborationApi;
  projectId?: string | null;
  compact?: boolean;
  title?: string;
}) {
  const query = useInfiniteQuery({
    queryKey: [...api.scopeKey, 'activity', projectId],
    queryFn: ({ pageParam }) => api.activity(projectId, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: page => page.next_before_id ?? undefined,
    refetchInterval: 30000,
    retry: false,
  });
  const available = query.error ? [] : (query.data?.pages.flatMap(page => page.items) ?? []);
  const items = compact ? available.slice(0, 6) : available;
  return (
    <section className={`pw-account-card pw-activity${compact ? ' pw-activity-compact' : ''}`} aria-label={title}>
      <h2>{title}</h2>
      <p className="faint">Solo se muestra la actividad que puedes consultar actualmente.</p>
      {query.error ? (
        <ErrorNotice>{errorMessage(query.error)}</ErrorNotice>
      ) : query.isPending ? (
        <Busy />
      ) : items.length ? (
        <ol className="pw-activity-list">
          {items.map(entry => (
            <li key={entry.id}>
              <span>
                <strong>{entry.actor_name}</strong> · {ACTION_NAMES[entry.action] ?? 'Registró un cambio'}
              </span>
              <time dateTime={entry.created_at}>
                {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.created_at))}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint">Todavía no hay actividad disponible.</p>
      )}
      {!compact && query.hasNextPage && !query.error && (
        <button className="btn btn-secondary btn-sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Cargar más actividad
        </button>
      )}
      {query.error && (
        <button className="btn btn-secondary btn-sm" onClick={() => void query.refetch()}>
          Actualizar actividad
        </button>
      )}
    </section>
  );
}

function RoleDialog({
  role,
  api,
  permissions,
  owner,
  onClose,
}: {
  role?: WorkspaceRole;
  api: CollaborationApi;
  permissions: string[];
  owner: boolean;
  onClose: () => void;
}) {
  const prefix = useId();
  const [name, setName] = useState(role?.name ?? '');
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? []);
  const [id] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (role) await api.updateRole(role, name, selected);
      else await api.createRole(id, name, selected);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog title={role ? 'Editar rol' : 'Crear rol'} onClose={onClose} busy={busy} wide>
      <form className="pw-form" onSubmit={event => void save(event)}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <label className="pw-field" htmlFor={`${prefix}-name`}>
            Nombre del rol
            <input
              id={`${prefix}-name`}
              data-initial-focus
              maxLength={80}
              required
              disabled={busy}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <p className="pw-info">
            Los permisos de varios roles se suman. Para actuar en un proyecto también hace falta acceso al proyecto; editar requiere acceso de escritura.
          </p>
          <fieldset className="pw-permission-grid" disabled={busy}>
            <legend>Permisos del rol</legend>
            {PERMISSIONS.map(([key, label]) => (
              <label key={key} className="pw-check-field">
                <input
                  type="checkbox"
                  checked={selected.includes(key)}
                  disabled={!owner && !permissions.includes(key)}
                  onChange={event => setSelected(previous => (event.target.checked ? [...previous, key] : previous.filter(item => item !== key)))}
                />
                <span>
                  {label}
                  <small>{key}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="faint">
            Las operaciones de proyectos necesitan «Ver proyectos»; las de tareas también necesitan «Ver tareas». Las dependencias no se añaden automáticamente.
          </p>
          {!owner && (
            <p className="faint">Puedes delegar tus facultades actuales. El servidor impide aumentar tus propios permisos o modificar roles superiores.</p>
          )}
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Guardando…' : 'Guardar rol'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function MemberRolesDialog({
  member,
  roles,
  api,
  permissions,
  owner,
  onClose,
}: {
  member: WorkspaceMember;
  roles: WorkspaceRole[];
  api: CollaborationApi;
  permissions: string[];
  owner: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(member.roles.map(role => role.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.setMemberRoles(member, selected);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Roles de ${member.display_name}`} busy={busy} onClose={onClose}>
      <form className="pw-form" onSubmit={event => void submit(event)}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <p>Selecciona todos los roles que correspondan. Sin roles no hay acceso efectivo a proyectos.</p>
          <fieldset className="pw-permission-grid" disabled={busy}>
            <legend>Roles del miembro</legend>
            {roles.map(role => (
              <label key={role.id} className="pw-check-field">
                <input
                  type="checkbox"
                  checked={selected.includes(role.id)}
                  disabled={!owner && role.permissions.some(permission => !permissions.includes(permission))}
                  onChange={event => setSelected(previous => (event.target.checked ? [...previous, role.id] : previous.filter(id => id !== role.id)))}
                />
                <span>
                  {role.name}
                  <small>{role.permissions.length} permisos</small>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
        <div className="pw-form-footer">
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar roles
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmAction({
  title,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function confirm() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <div className="pw-form-body">
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {children}
      </div>
      <div className="pw-form-footer">
        <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
        <button className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
          Confirmar
        </button>
      </div>
    </Dialog>
  );
}

export function TeamAdministration(props: WorkspaceProps) {
  const { workspace, collaboration: api, members = [], directoryLoading, directoryError, invitations = [] } = props;
  const canReadRoles = canInWorkspace(props, 'role.read');
  const queryClient = useQueryClient();
  const scopeUser = api?.scopeKey[1];
  const scopeWorkspace = api?.scopeKey[2];
  useEffect(() => {
    if (canReadRoles || !scopeUser || !scopeWorkspace) return;
    const filters = {
      predicate: (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] === 'collaboration' && query.queryKey[1] === scopeUser && query.queryKey[2] === scopeWorkspace && query.queryKey.at(-1) === 'roles',
    };
    void queryClient.cancelQueries(filters);
    queryClient.removeQueries(filters);
  }, [canReadRoles, scopeUser, scopeWorkspace, queryClient]);
  const roles = useQuery({
    queryKey: [...(api?.scopeKey ?? ['no-collaboration']), 'roles'],
    queryFn: () => api!.roles(),
    enabled: Boolean(api && canReadRoles),
    refetchInterval: 30000,
    retry: false,
  });
  const [editingRole, setEditingRole] = useState<{ role?: WorkspaceRole } | null>(null);
  const [editingMember, setEditingMember] = useState<WorkspaceMember | null>(null);
  const [deletingRole, setDeletingRole] = useState<WorkspaceRole | null>(null);
  const [removingMember, setRemovingMember] = useState<WorkspaceMember | null>(null);
  const canManageRoles = canInWorkspace(props, 'role.manage');
  const canAssignRoles = canInWorkspace(props, 'role.assign');
  const canRemove = canInWorkspace(props, 'member.remove');
  useEffect(() => {
    if (!canManageRoles || !canReadRoles || roles.error || props.accessUnavailable) {
      setEditingRole(null);
      setDeletingRole(null);
    }
    if (!canAssignRoles || !canReadRoles || directoryError || props.accessUnavailable) setEditingMember(null);
    if (!canRemove || directoryError || props.accessUnavailable) setRemovingMember(null);
  }, [canManageRoles, canAssignRoles, canReadRoles, canRemove, directoryError, props.accessUnavailable, roles.error]);
  if (workspace?.kind !== 'team')
    return (
      <div className="page">
        <EmptyState title="Este es tu espacio personal">Crea un equipo desde el selector de espacios para organizar trabajo compartido.</EmptyState>
      </div>
    );
  const owner = workspace.owner_id === props.currentUserId;
  const roleList = roles.error || !canReadRoles ? [] : (roles.data ?? []);
  const manageable = (role: WorkspaceRole) => owner || role.permissions.every(permission => workspace.permissions.includes(permission));
  const currentMember = editingMember && members.find(member => member.id === editingMember.id && member.can_manage_roles && !member.is_owner);
  const currentRemoval = removingMember && members.find(member => member.id === removingMember.id && member.can_remove && !member.is_owner);
  return (
    <div className="page pw-team-page">
      <div className="ph">
        <div>
          <div className="eyebrow">Equipo</div>
          <h1>{workspace.name}</h1>
          <p>Los proyectos son privados y requieren acceso explícito. El propietario puede consultar todos los proyectos de su equipo.</p>
        </div>
      </div>
      <TeamSummary data={props} />
      <section className="pw-account-card" aria-labelledby="team-members-title">
        <h2 id="team-members-title">Miembros</h2>
        {directoryError ? (
          <ErrorNotice>{directoryError}</ErrorNotice>
        ) : directoryLoading && !members.length ? (
          <Busy />
        ) : (
          <ul className="pw-member-list">
            {members.map(member => (
              <li key={member.id}>
                <span className="pw-avatar small">{member.display_name.charAt(0).toUpperCase()}</span>
                <span className="grow">
                  <strong>{member.display_name}</strong>
                  <small>
                    {member.is_owner ? 'Propietario protegido' : canReadRoles ? member.roles.map(role => role.name).join(', ') || 'Sin roles' : 'Miembro'}
                  </small>
                </span>
                {api && !member.is_owner && member.can_manage_roles && canAssignRoles && canReadRoles && (
                  <button className="btn btn-secondary btn-sm" disabled={props.pending} onClick={() => setEditingMember(member)}>
                    Editar roles
                  </button>
                )}
                {api && !member.is_owner && member.can_remove && canRemove && (
                  <button className="ibtn" aria-label={`Retirar a ${member.display_name}`} disabled={props.pending} onClick={() => setRemovingMember(member)}>
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!directoryError && !directoryLoading && !members.length && <p className="faint">No hay miembros disponibles para mostrar.</p>}
      </section>
      {canReadRoles && api && (
        <section className="pw-account-card" aria-labelledby="team-roles-title">
          <div className="row">
            <h2 id="team-roles-title" className="grow">
              Roles
            </h2>
            {canManageRoles && (
              <button className="btn btn-secondary" disabled={props.pending} onClick={() => setEditingRole({})}>
                <Plus size={14} aria-hidden="true" />
                Crear rol
              </button>
            )}
          </div>
          <p className="faint">Los roles son combinables. Sus nombres no conceden privilegios y no abren proyectos privados.</p>
          {roles.error ? (
            <ErrorNotice>{errorMessage(roles.error)}</ErrorNotice>
          ) : roles.isPending ? (
            <Busy />
          ) : (
            <ul className="pw-role-list">
              {roleList.map(role => (
                <li key={role.id}>
                  <div className="row">
                    <ShieldCheck size={18} aria-hidden="true" />
                    <strong className="grow">{role.name}</strong>
                    {canManageRoles && manageable(role) && (
                      <>
                        <button
                          className="btn btn-secondary btn-sm"
                          aria-label={`Editar rol ${role.name}`}
                          disabled={props.pending}
                          onClick={() => setEditingRole({ role })}
                        >
                          Editar<span className="sr"> {role.name}</span>
                        </button>
                        <button className="ibtn" aria-label={`Eliminar rol ${role.name}`} disabled={props.pending} onClick={() => setDeletingRole(role)}>
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                  <p className="pw-role-permissions">
                    {role.permissions.length
                      ? role.permissions.map(permission => PERMISSIONS.find(([key]) => key === permission)?.[1] ?? permission).join(' · ')
                      : 'Sin permisos'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="pw-account-card" aria-labelledby="team-invitations-title">
        <div className="row">
          <h2 id="team-invitations-title" className="grow">
            Invitaciones
          </h2>
          <button className="btn btn-secondary" disabled aria-describedby="team-invitation-help">
            <Plus size={14} aria-hidden="true" />
            Invitar miembro
          </button>
        </div>
        <p id="team-invitation-help" className="pw-info">
          Las altas externas están desactivadas hasta conectar un proveedor de correo con remitente verificado. Puedes preparar tu equipo y sus proyectos.
        </p>
        {!!invitations.length && (
          <ul className="pw-member-list">
            {invitations.map(invitation => (
              <li key={invitation.id}>
                <span className="grow">{invitation.email}</span>
                <span className="faint">{invitation.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {api && canInWorkspace(props, 'audit.read') && <ActivityPanel api={api} />}
      {api &&
        editingRole &&
        canManageRoles &&
        canReadRoles &&
        !roles.error &&
        (!editingRole.role || roleList.some(role => role.id === editingRole.role!.id && manageable(role))) && (
          <RoleDialog
            key={editingRole.role?.id ?? 'new'}
            api={api}
            role={editingRole.role}
            permissions={workspace.permissions}
            owner={owner}
            onClose={() => setEditingRole(null)}
          />
        )}
      {api && currentMember && canAssignRoles && canReadRoles && !roles.error && (
        <MemberRolesDialog
          key={currentMember.id}
          api={api}
          member={editingMember!}
          roles={roleList}
          permissions={workspace.permissions}
          owner={owner}
          onClose={() => setEditingMember(null)}
        />
      )}
      {api && deletingRole && canManageRoles && canReadRoles && roleList.some(role => role.id === deletingRole.id && manageable(role)) && (
        <ConfirmAction title={`Eliminar rol ${deletingRole.name}`} onClose={() => setDeletingRole(null)} onConfirm={() => api.deleteRole(deletingRole)}>
          <p>Se retirará este rol de sus miembros. Sus demás roles se conservan. Las tareas de quienes pierdan acceso se quedarán sin responsable.</p>
        </ConfirmAction>
      )}
      {api && currentRemoval && canRemove && (
        <ConfirmAction
          title={`Retirar a ${currentRemoval.display_name}`}
          onClose={() => setRemovingMember(null)}
          onConfirm={() => api.removeMember(removingMember!)}
        >
          <p>Perderá el acceso al equipo. Sus proyectos y tareas se conservarán y se retirarán las asignaciones que ya no sean válidas.</p>
        </ConfirmAction>
      )}
    </div>
  );
}

export function ProjectAccessDialog({
  project,
  api,
  members,
  currentUserId,
  canReadMembers = true,
  onClose,
}: {
  project: Project;
  api: CollaborationApi;
  members: WorkspaceMember[];
  currentUserId?: string;
  canReadMembers?: boolean;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: [...api.scopeKey, 'access', project.id],
    queryFn: () => api.projectAccess(project.id),
    refetchInterval: 30000,
    retry: false,
  });
  const [memberId, setMemberId] = useState('');
  const [level, setLevel] = useState<'read' | 'write'>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const lock = useRef(false);
  const items = query.error ? [] : (query.data ?? []);
  const eligible = members.filter(member => member.status === 'active' && !member.is_owner && member.user_id !== currentUserId);
  const available = eligible.filter(member => !items.some(access => access.member_id === member.id));
  async function run(work: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      setMemberId('');
      setConfirmRemove(null);
      await query.refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Acceso a ${project.name}`} onClose={onClose} busy={busy} wide>
      <div className="pw-form-body">
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <p className="pw-info">
          Solo miembros activos del equipo. El acceso de lectura o escritura se combina con sus roles. El propietario conserva acceso protegido.
        </p>
        {query.error ? (
          <ErrorNotice>{errorMessage(query.error)}</ErrorNotice>
        ) : query.isPending ? (
          <Busy />
        ) : (
          <ul className="pw-member-list">
            {items.map(access => {
              const member = members.find(item => item.id === access.member_id);
              const protectedMember = member?.is_owner || member?.user_id === currentUserId;
              return (
                <li key={access.member_id}>
                  <Users size={17} aria-hidden="true" />
                  <span className="grow">{access.display_name}</span>
                  <label>
                    <span className="sr">Acceso de {access.display_name}</span>
                    <select
                      value={access.access_level}
                      disabled={busy || protectedMember}
                      onChange={event =>
                        void run(() => api.setProjectAccess(project.id, access.member_id, access.version, event.target.value as 'read' | 'write'))
                      }
                    >
                      <option value="read">Lectura</option>
                      <option value="write">Escritura</option>
                    </select>
                  </label>
                  {!protectedMember && (
                    <button
                      className="ibtn"
                      disabled={busy}
                      aria-label={`Retirar acceso de ${access.display_name}`}
                      onClick={() => setConfirmRemove(access.member_id)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  )}
                  {confirmRemove === access.member_id && (
                    <div className="pw-confirm">
                      <p>Retirar el acceso desasignará sus tareas si deja de poder leerlas.</p>
                      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void run(() => api.removeProjectAccess(access))}>
                        Retirar acceso
                      </button>
                      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirmRemove(null)}>
                        Cancelar
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!query.isPending && !query.error && !items.length && <p className="faint">Este proyecto todavía no se comparte con otros miembros.</p>}
        {!canReadMembers && (
          <p className="pw-info">Para elegir nuevos miembros en esta pantalla necesitas el permiso «Ver miembros». Puedes gestionar los accesos existentes.</p>
        )}
        {available.length > 0 && !query.error && (
          <form
            className="pw-access-form"
            onSubmit={event => {
              event.preventDefault();
              if (memberId) void run(() => api.setProjectAccess(project.id, memberId, 0, level));
            }}
          >
            <label className="pw-field">
              Miembro
              <select value={memberId} required disabled={busy} onChange={event => setMemberId(event.target.value)}>
                <option value="">Selecciona un miembro</option>
                {available.map(member => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="pw-field">
              Acceso
              <select value={level} disabled={busy} onChange={event => setLevel(event.target.value as 'read' | 'write')}>
                <option value="read">Lectura</option>
                <option value="write">Escritura</option>
              </select>
            </label>
            <button className="btn btn-primary" disabled={busy || !memberId}>
              Conceder acceso
            </button>
          </form>
        )}
      </div>
      <div className="pw-form-footer">
        <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Dialog>
  );
}
