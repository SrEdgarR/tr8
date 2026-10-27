import { Star } from 'lucide-react';
import './productivity-shell.css';

export default function FavoriteButton({ name, active, disabled, onClick }: { name: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`ibtn pw-favorite${active ? ' is-favorite' : ''}`}
      aria-label={`${active ? 'Quitar' : 'Añadir'} ${name} ${active ? 'de' : 'a'} favoritos`}
      title={active ? 'Quitar de favoritos' : 'Añadir a favoritos'}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Star size={14} fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  );
}
