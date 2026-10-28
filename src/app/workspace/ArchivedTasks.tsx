import { Archive, ChevronRight } from 'lucide-react';
import type { Task } from '../types';
import { formatDate } from '../constants';
import { EmptyState } from './ui';
import TaskMetadata from './TaskMetadata';

export default function ArchivedTasks({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  return (
    <section className="wm-archives" aria-label="Tareas archivadas">
      <p className="muted">Las tareas archivadas conservan su historial. Ábrelas para consultar sus detalles o restaurarlas.</p>
      {tasks.length ? (
        tasks.map(task => (
          <article key={task.id} className="wm-archive-row">
            <Archive size={16} aria-hidden="true" />
            <button className="wm-archive-open" onClick={() => onOpen(task)}>
              <strong>{task.title}</strong>
              <small>Archivada el {formatDate(task.archived_at!.slice(0, 10))}</small>
              <TaskMetadata task={task} />
            </button>
            <button className="ibtn" aria-label={`Abrir tarea archivada ${task.title}`} onClick={() => onOpen(task)}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </article>
        ))
      ) : (
        <EmptyState title="No hay tareas archivadas">Las tareas que archives en este proyecto aparecerán aquí.</EmptyState>
      )}
    </section>
  );
}
