import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSummary } from '../types';
import WorkspacePicker from './WorkspacePicker';

const spaces: WorkspaceSummary[] = [
  { id: 'personal', name: 'Mi espacio', kind: 'personal', owner_id: 'owner', version: 1, permissions: [] },
  { id: 'studio', name: 'Horizon Studios', kind: 'team', owner_id: 'owner', version: 1, permissions: [] },
  { id: 'work', name: 'Trabajo compartido', kind: 'team', owner_id: 'another', version: 1, permissions: [] },
];

describe('workspace picker', () => {
  it('shows workspace identity and type, marks selection, and switches through the existing callback', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspacePicker workspaces={spaces} selectedId="personal" onSelect={onSelect} />);
    const trigger = screen.getByRole('combobox', { name: 'Espacio de trabajo' });
    expect(trigger).toHaveTextContent('Mi espacio personal');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(screen.getByRole('listbox', { name: 'Espacios de trabajo' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Mi espacio personal', selected: true })).toHaveTextContent('Personal');
    expect(screen.getByRole('option', { name: 'Horizon Studios', selected: false })).toHaveTextContent('Equipo');
    await user.click(screen.getByRole('option', { name: 'Horizon Studios' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('studio');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('supports arrows, Home, End, Enter and Space while selection stays explicit', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspacePicker workspaces={spaces} selectedId="personal" onSelect={onSelect} />);
    const trigger = screen.getByRole('combobox', { name: 'Espacio de trabajo' });
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Horizon Studios' }).id);
    await user.keyboard('{End}');
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Trabajo compartido' }).id);
    await user.keyboard('{Home}');
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Mi espacio personal' }).id);
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard(' {End}{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('work');
  });
  it('cancels navigation with Escape, closes on Tab and dismisses a click outside', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <>
        <WorkspacePicker workspaces={spaces} selectedId="personal" onSelect={onSelect} />
        <button>Después</button>
      </>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Espacio de trabajo' });
    await user.click(trigger);
    await user.keyboard('{End}{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.tab();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Después' })).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Después' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('allows typeahead without applying another workspace until confirmed', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspacePicker workspaces={spaces} selectedId="personal" onSelect={onSelect} />);
    screen.getByRole('combobox', { name: 'Espacio de trabajo' }).focus();
    await user.keyboard('hori');
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('studio');
  });
  it('removes an open menu when pending begins and withdraws old workspace names on scope change', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const view = render(<WorkspacePicker workspaces={spaces} selectedId="personal" onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox', { name: 'Espacio de trabajo' }));
    view.rerender(<WorkspacePicker workspaces={spaces} selectedId="personal" onSelect={onSelect} disabled />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Espacio de trabajo' })).toBeDisabled();
    view.rerender(<WorkspacePicker workspaces={[spaces[2]]} selectedId="work" onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox', { name: 'Espacio de trabajo' }));
    expect(screen.queryByRole('option', { name: 'Horizon Studios' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('does not open with a missing selected workspace or missing switching capability', () => {
    const onSelect = vi.fn();
    const view = render(<WorkspacePicker workspaces={spaces} selectedId="unavailable" onSelect={onSelect} />);
    expect(screen.getByRole('combobox', { name: 'Espacio de trabajo' })).toBeDisabled();
    view.rerender(<WorkspacePicker workspaces={spaces} selectedId="personal" />);
    const trigger = screen.getByRole('combobox', { name: 'Espacio de trabajo' });
    expect(trigger).toBeDisabled();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
