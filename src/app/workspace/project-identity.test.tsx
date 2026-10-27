import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isProjectIcon, projectIconName, PROJECT_ICONS } from '../project-identity';
import { IdentityAvatar, PriorityIcon, ProjectGlyph, TaskStatusIcon } from './project-identity';
import { ProjectIcon } from './ui';

describe('vocabulario y símbolos de la demo', () => {
  it('admite solo identificadores conocidos y mantiene el fallback seguro para versiones anteriores', () => {
    expect(PROJECT_ICONS).toHaveLength(16);
    expect(PROJECT_ICONS.every(icon => isProjectIcon(icon.id))).toBe(true);
    for (const invalid of [undefined, null, '', 'url(https://example.test)', '<svg onload=alert(1)>', 'constructor']) {
      expect(isProjectIcon(invalid)).toBe(false);
      expect(projectIconName(invalid)).toBe('folder');
    }
    const { container } = render(<ProjectGlyph icon="https://example.test/icon.svg" />);
    expect(container.querySelector('svg.lucide-folder-closed')).toBeInTheDocument();
    expect(container.querySelector('img, image, script')).not.toBeInTheDocument();
  });

  it('presenta el icono guardado con la cápsula de color original', () => {
    const { container } = render(<ProjectIcon icon="rocket" color="#23918A" large />);
    expect(container.querySelector('.picon.lg')).toHaveStyle('--c: #23918A');
    expect(container.querySelector('svg.lucide-rocket')).toBeInTheDocument();
  });

  it('distingue los estados también por forma y las prioridades por barras', () => {
    const { container } = render(
      <>
        <TaskStatusIcon status="backlog" />
        <TaskStatusIcon status="progress" />
        <TaskStatusIcon status="review" />
        <TaskStatusIcon status="done" />
        <PriorityIcon priority="high" />
        <PriorityIcon priority="urgent" />
      </>,
    );
    expect(container.querySelector('.is-backlog circle')).toHaveAttribute('stroke-dasharray', '1.9 2.1');
    expect(container.querySelector('.is-progress path')).toBeInTheDocument();
    expect(container.querySelector('.is-review path')).toBeInTheDocument();
    expect(container.querySelector('.is-done path')).toHaveAttribute('stroke', 'var(--surface)');
    expect(container.querySelectorAll('.pw-priority-icon.is-high rect')).toHaveLength(3);
    expect(container.querySelector('.pw-priority-icon.is-urgent rect')).toHaveAttribute('fill', 'var(--red)');
    expect(container.querySelector('.pw-priority-icon.is-urgent path')).toHaveAttribute('stroke', 'var(--surface)');
  });

  it('mantiene iniciales, color y nombre accesible estables para cada persona', () => {
    const { container } = render(
      <>
        <IdentityAvatar name="Edgar Padilla" />
        <IdentityAvatar name="Edgar Padilla" small decorative />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Edgar Padilla' })).toHaveTextContent('EP');
    const avatars = container.querySelectorAll('.pw-identity-avatar');
    expect(avatars[0].getAttribute('style')).toEqual(avatars[1].getAttribute('style'));
    expect(avatars[1]).toHaveAttribute('aria-hidden', 'true');
  });
});
