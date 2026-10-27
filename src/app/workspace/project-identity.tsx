import type { CSSProperties } from 'react';
import {
  Briefcase,
  Building2,
  Code,
  Component,
  FolderClosed,
  Globe,
  Heart,
  Layers,
  LayoutGrid,
  Megaphone,
  Palette,
  Rocket,
  Smartphone,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { PROJECT_COLORS } from '../constants';
import { projectIconName, type ProjectIconName } from '../project-identity';
import type { Priority, ProjectStatus, TaskStatus } from '../types';
import './project-identity.css';

const glyphs = {
  globe: Globe,
  smartphone: Smartphone,
  megaphone: Megaphone,
  rocket: Rocket,
  component: Component,
  'building-2': Building2,
  'layout-grid': LayoutGrid,
  palette: Palette,
  code: Code,
  briefcase: Briefcase,
  target: Target,
  layers: Layers,
  zap: Zap,
  heart: Heart,
  folder: FolderClosed,
  sparkles: Sparkles,
} satisfies Record<ProjectIconName, typeof Globe>;

export function ProjectGlyph({ icon, size = 16 }: { icon?: string; size?: number }) {
  const Glyph = glyphs[projectIconName(icon)];
  return <Glyph size={size} aria-hidden="true" />;
}

export function TaskStatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className={`pw-status-icon is-${status}`}>
      {status === 'done' ? (
        <>
          <circle cx="7" cy="7" r="6.2" fill="currentColor" />
          <path d="m4.4 7.2 1.8 1.8 3.5-3.7" fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={status === 'backlog' ? '1.9 2.1' : undefined} />
          {status === 'progress' && <path d="M7 3.4a3.6 3.6 0 0 1 0 7.2Z" fill="currentColor" />}
          {status === 'review' && <path d="M7 3.4A3.6 3.6 0 1 1 3.4 7H7Z" fill="currentColor" />}
        </>
      )}
    </svg>
  );
}

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const strength = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }[priority];
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className={`pw-priority-icon is-${priority}`}>
      {priority === 'urgent' ? (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--red)" />
          <path d="M7 3.8v4" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r=".95" fill="var(--surface)" />
        </>
      ) : priority === 'none' ? (
        <path d="M2.5 7h2M6 7h2m1.5 0h2" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        [4.5, 7.5, 10.5].map((height, index) => (
          <rect
            key={height}
            x={1.8 + index * 3.9}
            y={12 - height}
            width="2.6"
            height={height}
            rx="1"
            fill={strength > index ? 'var(--text-2)' : 'var(--border-strong)'}
          />
        ))
      )}
    </svg>
  );
}

const projectStatusColors: Record<ProjectStatus, string> = {
  planning: 'var(--gray)',
  active: 'var(--blue)',
  hold: 'var(--amber)',
  complete: 'var(--green)',
};

export function ProjectStatusDot({ status }: { status: ProjectStatus }) {
  return <span className="pw-project-status-dot" style={{ background: projectStatusColors[status] }} aria-hidden="true" />;
}

export function IdentityAvatar({ name, small = false, decorative = false }: { name: string; small?: boolean; decorative?: boolean }) {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/u)
    .filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words.at(-1)![0] : (words[0] ?? '?').slice(0, 2)).toLocaleUpperCase('es');
  const index = Array.from(name).reduce((hash, character) => (hash * 31 + character.codePointAt(0)!) >>> 0, 0) % PROJECT_COLORS.length;
  return (
    <span
      className={`pw-identity-avatar${small ? ' small' : ''}`}
      style={{ '--identity-color': PROJECT_COLORS[index] } as CSSProperties}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : name}
      role={decorative ? undefined : 'img'}
    >
      {initials}
    </span>
  );
}
