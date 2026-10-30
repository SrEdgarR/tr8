import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Workspace from './Workspace';
import { summaryProps } from './summary-test-fixtures';

function mount(compact: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: compact && query.includes('900px'), addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  const props = summaryProps();
  props.workspaces = [props.workspace!];
  props.onSelectWorkspace = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Workspace {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, props };
}

afterEach(() => vi.unstubAllGlobals());

describe('navegación móvil modal', () => {
  it('usa el atajo de barra lateral para abrir el menú móvil sin contraer el escritorio', () => {
    const { container } = mount(true);
    fireEvent.keyDown(document, { key: '[' });
    expect(screen.getByRole('dialog', { name: 'Navegación principal' })).toBeInTheDocument();
    expect(container.querySelector('.shell')).not.toHaveClass('collapsed');
  });
  it('excluye el menú cerrado, contiene el foco y lo devuelve al cerrar con Escape', async () => {
    const { container, props } = mount(true);
    const sidebar = container.querySelector('#tr8-sidebar')!;
    const main = container.querySelector('.main')!;
    expect(sidebar).toHaveAttribute('inert');
    const trigger = screen.getByRole('button', { name: 'Abrir navegación' });
    await userEvent.click(trigger);
    const menu = screen.getByRole('dialog', { name: 'Navegación principal' });
    expect(menu).toHaveAttribute('aria-modal', 'true');
    expect(sidebar).not.toHaveAttribute('inert');
    expect(main).toHaveAttribute('inert');
    expect(within(menu).getByRole('button', { name: 'Cerrar menú de navegación' })).toHaveFocus();
    const first = within(menu).getByRole('link', { name: 'Inicio de TR8' });
    const last = within(menu).getByRole('link', { name: props.email });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(sidebar).toHaveAttribute('inert');
    expect(main).not.toHaveAttribute('inert');
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it('cierra el menú antes de abrir un formulario, sin modificar proyectos ni tareas', async () => {
    const { container, props } = mount(true);
    await userEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    const menu = screen.getByRole('dialog', { name: 'Navegación principal' });
    await userEvent.click(within(menu).getByRole('button', { name: 'Crear proyecto' }));
    expect(screen.getByRole('dialog', { name: 'Nuevo proyecto' })).toBeInTheDocument();
    expect(container.querySelector('#tr8-sidebar')).toHaveAttribute('inert');
    expect(container.querySelector('.main')).not.toHaveAttribute('inert');
    expect(props.onCreateProject).not.toHaveBeenCalled();
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it('conserva la barra de escritorio disponible y sin modalizar el contenido', () => {
    const { container } = mount(false);
    expect(screen.getByRole('complementary', { name: 'Navegación principal' })).not.toHaveAttribute('inert');
    expect(container.querySelector('.main')).not.toHaveAttribute('inert');
  });

  it('cierra primero el selector de espacios con Escape y conserva la navegación abierta', async () => {
    mount(true);
    await userEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    const picker = screen.getByRole('combobox', { name: 'Espacio de trabajo' });
    await userEvent.click(picker);
    expect(screen.getByRole('listbox', { name: 'Espacios de trabajo' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Espacios de trabajo' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Navegación principal' })).toBeInTheDocument();
    expect(picker).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Navegación principal' })).not.toBeInTheDocument();
  });
});
