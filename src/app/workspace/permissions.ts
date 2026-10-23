import type { WorkspaceProps } from '../types';

export const PERMISSIONS = [
  ['team.settings.edit', 'Editar configuración del equipo'],
  ['member.read', 'Ver miembros'],
  ['member.invite', 'Gestionar invitaciones'],
  ['member.remove', 'Retirar miembros'],
  ['role.read', 'Ver roles'],
  ['role.manage', 'Crear, editar y eliminar roles'],
  ['role.assign', 'Asignar roles'],
  ['project.create', 'Crear proyectos'],
  ['project.read', 'Ver proyectos con acceso'],
  ['project.edit', 'Editar proyectos'],
  ['project.archive', 'Archivar y restaurar proyectos'],
  ['project.access.manage', 'Gestionar acceso a proyectos (Ver miembros permite elegir nuevos destinatarios)'],
  ['task.read', 'Ver tareas'],
  ['task.create', 'Crear tareas'],
  ['task.edit', 'Editar tareas'],
  ['task.delete', 'Eliminar tareas'],
  ['task.assign', 'Asignar responsable de tareas'],
  ['audit.read', 'Ver actividad autorizada'],
] as const;

export function canInWorkspace(props: Pick<WorkspaceProps, 'workspace' | 'currentUserId' | 'readOnly'>, permission: string) {
  if (!props.workspace) return !props.readOnly;
  return props.workspace.owner_id === props.currentUserId || props.workspace.permissions.includes(permission);
}

export function canInProject(props: Pick<WorkspaceProps, 'capabilities' | 'readOnly'>, projectId: string, permission: string) {
  if (!props.capabilities) return !props.readOnly;
  return props.capabilities[projectId]?.permissions.includes(permission) ?? false;
}
