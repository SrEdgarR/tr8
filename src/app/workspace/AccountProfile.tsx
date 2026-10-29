import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Save, UserRound } from 'lucide-react';
import type { ProfileApi, UserProfile } from '../profile-types';
import { Busy, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import './account-profile.css';

export default function AccountProfile({ api, disabled = false }: { api: ProfileApi; disabled?: boolean }) {
  return <ScopedAccountProfile key={JSON.stringify(api.scopeKey)} api={api} disabled={disabled} />;
}
function ScopedAccountProfile({ api, disabled }: { api: ProfileApi; disabled: boolean }) {
  const client = useQueryClient();
  const key = [...api.scopeKey, 'identity'];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api.load(signal), retry: false, gcTime: 0 });
  const [draft, setDraft] = useState<{ profile: UserProfile; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const profile = query.error ? null : query.data;
  const name = draft?.name ?? (profile?.display_name === 'Usuario' ? '' : (profile?.display_name ?? ''));
  const changed = Boolean(profile && draft && draft.profile.updated_at !== profile.updated_at);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || lock.current || !draft || !profile || !name.trim() || changed) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.save(draft.profile, name.trim());
      if (!active.current) return;
      client.setQueryData(key, saved);
      setDraft(null);
      setNotice('Nombre actualizado. Se mostrará en tu actividad y en los equipos donde participas.');
    } catch (cause) {
      if (!active.current) return;
      setError(errorMessage(cause));
      const confirmation = await query.refetch();
      if (active.current && confirmation.data?.display_name === name.trim()) {
        setDraft(null);
        setError('');
        setNotice('Nombre confirmado al actualizar tu perfil.');
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="pw-profile" aria-labelledby="profile-name-heading">
      <h3 id="profile-name-heading">
        <UserRound size={16} aria-hidden="true" /> Nombre visible
      </h3>
      <p>Así aparecerás en la actividad, los comentarios y los equipos.</p>
      {query.isPending ? (
        <Busy>Comprobando tu perfil…</Busy>
      ) : query.error ? (
        <>
          <ErrorNotice>{errorMessage(query.error)}</ErrorNotice>
          <button type="button" className="btn btn-secondary" onClick={() => void query.refetch()}>
            Reintentar perfil
          </button>
        </>
      ) : (
        profile && (
          <form onSubmit={event => void save(event)} className="pw-profile-form">
            <label className="pw-field">
              Tu nombre
              <span className="pw-profile-input">
                <UserRound size={15} aria-hidden="true" />
                <input
                  maxLength={120}
                  required
                  placeholder="Escribe tu nombre"
                  value={name}
                  disabled={disabled || busy}
                  onChange={event => {
                    setDraft({ profile: draft?.profile ?? profile, name: event.target.value });
                    setNotice('');
                  }}
                />
              </span>
            </label>
            <button className="btn btn-primary" disabled={disabled || busy || changed || !draft || !name.trim() || name.trim() === profile.display_name}>
              <Save size={14} aria-hidden="true" />
              {busy ? 'Guardando…' : 'Guardar nombre'}
            </button>
            {changed && (
              <p className="pw-info">
                Tu perfil cambió en otra sesión.{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setError('');
                  }}
                >
                  Revisar nombre actualizado
                </button>
              </p>
            )}
          </form>
        )
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && (
        <p className="pw-profile-notice" role="status">
          <Check size={14} aria-hidden="true" />
          {notice}
        </p>
      )}
    </section>
  );
}
