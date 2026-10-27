import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TeamSummary from './TeamSummary';
import { summaryMember, summaryProject, summaryProps, summaryTask } from './summary-test-fixtures';

describe('resumen real del equipo', () => {
  it('resume solo proyectos activos autorizados y conserva el contexto al abrirlos', () => {
    const hidden = { ...summaryProject, id: 'private', name: 'Privado', workspace_id: 'other-workspace' };
    const archived = { ...summaryProject, id: 'archived', name: 'Archivado', archived_at: '2026-10-26T12:00:00Z' };
    const data = summaryProps({
      projects: [summaryProject, hidden, archived],
      tasks: [summaryTask, { ...summaryTask, id: 'hidden-task', project_id: hidden.id, workspace_id: hidden.workspace_id }],
    });
    render(
      <MemoryRouter>
        <TeamSummary data={data} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Resumen del equipo' })).toBeInTheDocument();
    expect(screen.queryByText(hidden.name)).not.toBeInTheDocument();
    expect(screen.queryByText(archived.name)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Revista/ })).toHaveAttribute(
      'href',
      `/projects/${summaryProject.id}?workspace=${summaryProject.workspace_id}&view=overview`,
    );
    expect(screen.getByRole('link', { name: 'Vista general' })).toHaveAttribute('href', `/overview?workspace=${summaryProject.workspace_id}`);
  });

  it('muestra la carga a partir de asignaciones visibles sin incluir otras tareas o miembros retirados', () => {
    render(
      <MemoryRouter>
        <TeamSummary
          data={summaryProps({
            members: [summaryMember, { ...summaryMember, id: 'removed', display_name: 'Retirado', status: 'removed' }],
            tasks: [summaryTask, { ...summaryTask, id: 'unassigned', assignee_member_id: null }, { ...summaryTask, id: 'done', status: 'done' }],
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(summaryMember.display_name)).toBeInTheDocument();
    expect(screen.getByText('Sin responsable')).toBeInTheDocument();
    expect(screen.queryByText('Retirado')).not.toBeInTheDocument();
    const workload = screen.getByRole('heading', { name: 'Carga de trabajo' }).closest('section')!;
    expect(within(workload).getAllByText('1')).toHaveLength(2);
  });

  it.each([{ directoryError: 'Sin conexión' }, { directoryLoading: true }])(
    'no presenta miembros como cero ni revela nombres en un estado no confirmado: %j',
    extra => {
      render(
        <MemoryRouter>
          <TeamSummary data={summaryProps(extra)} />
        </MemoryRouter>,
      );
      expect(screen.queryByText(summaryMember.display_name)).not.toBeInTheDocument();
      const metric = screen.getByText('Miembros activos').closest('div')!;
      expect(within(metric).queryByText('0')).not.toBeInTheDocument();
      expect(within(metric).getByText(extra.directoryLoading ? 'Cargando…' : 'No disponible')).toBeInTheDocument();
    },
  );

  it('trata directorio y tareas sin permisos como no disponibles', () => {
    render(
      <MemoryRouter>
        <TeamSummary
          data={summaryProps({
            currentUserId: 'reader',
            capabilities: { [summaryProject.id]: { project_id: summaryProject.id, access_level: 'read', permissions: ['project.read'] } },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Tareas sin acceso')).toBeInTheDocument();
    expect(screen.getByText('Cobertura parcial por permisos')).toBeInTheDocument();
    expect(screen.getByText('Sin acceso')).toBeInTheDocument();
    expect(screen.queryByText(summaryMember.display_name)).not.toBeInTheDocument();
  });

  it('retira los datos después de una revocación y no monta el resumen de equipo en el espacio personal', () => {
    const data = summaryProps();
    const { container, rerender } = render(
      <MemoryRouter>
        <TeamSummary data={data} />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <TeamSummary data={{ ...data, accessUnavailable: true }} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <MemoryRouter>
        <TeamSummary data={{ ...data, workspace: { ...data.workspace!, kind: 'personal' } }} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
