import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceProps } from '../types';
import { FILE_MAX_BYTES, PROJECT_FILES_MAX_BYTES, PROJECT_FILES_MAX_COUNT, type ProjectFilesApi } from '../project-files-types';
import Workspace from './Workspace';
import { summaryProps, summaryProject } from './summary-test-fixtures';

function api(): ProjectFilesApi {
  return {
    scopeKey: ['files', 'integration'],
    list: vi
      .fn()
      .mockResolvedValue({ items: [], used_bytes: 0, max_bytes: PROJECT_FILES_MAX_BYTES, max_file_bytes: FILE_MAX_BYTES, max_files: PROJECT_FILES_MAX_COUNT }),
    upload: vi.fn(),
    download: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  };
}
function mount(props: WorkspaceProps, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Workspace {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe('archivos integrados por proyecto', () => {
  it('consulta solo al abrir la pestaña y alterna proyectos conservando un único panel', async () => {
    const user = userEvent.setup(),
      files = api();
    const second = { ...summaryProject, id: 'project-second', name: 'Lanzamiento', code: 'P-B' };
    const props = summaryProps({ projectFiles: files, projects: [summaryProject, second] });
    const { container } = mount(props, `/projects/${summaryProject.id}?workspace=${summaryProject.workspace_id}`);
    expect(files.list).not.toHaveBeenCalled();
    await user.click(within(screen.getByLabelText('Vista de tareas')).getByRole('button', { name: 'Archivos' }));
    await waitFor(() => expect(files.list).toHaveBeenCalledWith(summaryProject, expect.any(AbortSignal)));
    expect(container.querySelectorAll('.pwf-page')).toHaveLength(1);
    await user.click(within(screen.getByRole('complementary')).getByRole('link', { name: second.name }));
    await user.click(within(screen.getByLabelText('Vista de tareas')).getByRole('button', { name: 'Archivos' }));
    await waitFor(() => expect(files.list).toHaveBeenCalledWith(second, expect.any(AbortSignal)));
    expect(container.querySelectorAll('.pwf-page')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: `Archivos de ${summaryProject.name}` })).not.toBeInTheDocument();
    expect(files.upload).not.toHaveBeenCalled();
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });
  it('bloquea consultas de una URL con un proyecto obsoleto ya sin acceso', () => {
    const files = api();
    mount(summaryProps({ projectFiles: files, capabilities: {}, currentUserId: 'removed-reader' }), `/projects/${summaryProject.id}?view=files`);
    expect(files.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Subir archivos' })).not.toBeInTheDocument();
  });
});
