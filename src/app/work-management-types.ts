import type { Project, ProjectInput, Task, TaskSubtask } from './types';

export type ProjectTemplateKey = 'website' | 'launch' | 'sprint';
export const PROJECT_TEMPLATES: readonly { key: ProjectTemplateKey; name: string; description: string; tasks: readonly string[] }[] = [
  {
    key: 'website',
    name: 'Sitio web',
    description: 'De la estructura a la publicación.',
    tasks: ['Definir alcance y estructura', 'Diseñar las pantallas', 'Construir el sitio', 'Revisar contenido y accesibilidad', 'Publicar y verificar'],
  },
  {
    key: 'launch',
    name: 'Lanzamiento',
    description: 'Preparar y coordinar una entrega.',
    tasks: ['Definir objetivos del lanzamiento', 'Preparar los materiales', 'Revisar la entrega', 'Publicar el lanzamiento', 'Recoger resultados'],
  },
  {
    key: 'sprint',
    name: 'Sprint',
    description: 'Planificar, ejecutar y revisar el trabajo.',
    tasks: ['Preparar el backlog', 'Planificar el sprint', 'Desarrollar la entrega', 'Validar los cambios', 'Revisar y hacer retrospectiva'],
  },
];

export interface TaskDetailsInput {
  labels: string[];
  estimate_minutes: number | null;
  subtasks: TaskSubtask[];
}

export interface WorkManagementApi {
  scopeKey: string[];
  createProject: (input: ProjectInput, requestId: string) => Promise<Project>;
  updateProject: (project: Project, input: ProjectInput) => Promise<Project>;
  duplicateProject: (project: Project, input: { name: string; includeTasks: boolean }, requestId: string) => Promise<Project>;
  updateTaskDetails: (task: Task, input: TaskDetailsInput) => Promise<Task>;
  duplicateTask: (task: Task, targetProjectId: string, requestId: string) => Promise<Task>;
  moveTask: (task: Task, targetProjectId: string, requestId: string, clearAssignee?: boolean) => Promise<Task>;
  archiveTask: (task: Task, archived: boolean, requestId: string) => Promise<Task>;
}
