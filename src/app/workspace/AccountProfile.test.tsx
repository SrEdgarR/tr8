import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileApi, UserProfile } from '../profile-types';
import { DataError } from '../data/errors';
import AccountProfile from './AccountProfile';

const original: UserProfile = { user_id: 'owner-a', display_name: 'Usuario', updated_at: '2026-10-29T10:00:00.000Z' };
const changed: UserProfile = { ...original, display_name: 'Nombre elegido', updated_at: '2026-10-29T11:00:00.000Z' };
const clients: QueryClient[] = [];
function api(): ProfileApi {
  return { scopeKey: ['profile', 'owner-a', 'personal-a'], load: vi.fn().mockResolvedValue(original), save: vi.fn().mockResolvedValue(changed) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function show(source: ProfileApi, disabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <AccountProfile api={source} disabled={disabled} />
    </QueryClientProvider>,
  );
  return {
    client,
    ...view,
    change: (next: ProfileApi, nextDisabled = false) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <AccountProfile api={next} disabled={nextDisabled} />
        </QueryClientProvider>,
      ),
  };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('account display name', () => {
  it('loads only this account and leaves the generic name blank without inventing an identity', async () => {
    const source = api();
    show(source);
    expect(await screen.findByRole('textbox', { name: 'Tu nombre' })).toHaveValue('');
    expect(source.load).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: 'Guardar nombre' })).toBeDisabled();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('saves the typed name with the loaded CAS identity through keyboard submission', async () => {
    const user = userEvent.setup();
    const source = api();
    const { client } = show(source);
    const input = await screen.findByRole('textbox', { name: 'Tu nombre' });
    await user.type(input, '  Nombre elegido  {Enter}');
    await waitFor(() => expect(source.save).toHaveBeenCalledExactlyOnceWith(original, 'Nombre elegido'));
    expect(await screen.findByRole('status')).toHaveTextContent('Nombre actualizado');
    expect(input).toHaveValue('Nombre elegido');
    expect(client.getQueryData([...source.scopeKey, 'identity'])).toEqual(changed);
    expect(screen.getByRole('button', { name: 'Guardar nombre' })).toBeDisabled();
  });

  it('does not save blank, unchanged or disabled values', async () => {
    const user = userEvent.setup();
    const source = api();
    vi.mocked(source.load).mockResolvedValue(changed);
    const view = show(source);
    const input = await screen.findByRole('textbox', { name: 'Tu nombre' });
    expect(input).toHaveValue('Nombre elegido');
    expect(screen.getByRole('button', { name: 'Guardar nombre' })).toBeDisabled();
    await user.clear(input);
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: 'Guardar nombre' })).toBeDisabled();
    view.change(source, true);
    expect(input).toBeDisabled();
    expect(source.save).not.toHaveBeenCalled();
  });

  it('offers an explicit retry after a profile read fails', async () => {
    const user = userEvent.setup();
    const source = api();
    vi.mocked(source.load).mockRejectedValueOnce(new Error('No hay conexión'));
    show(source);
    expect(await screen.findByRole('alert')).toHaveTextContent('No hay conexión');
    expect(screen.queryByRole('textbox', { name: 'Tu nombre' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar perfil' }));
    expect(await screen.findByRole('textbox', { name: 'Tu nombre' })).toHaveValue('');
    expect(source.load).toHaveBeenCalledTimes(2);
  });

  it('keeps a conflicting draft until the user explicitly reviews the new server name', async () => {
    const user = userEvent.setup();
    const source = api();
    vi.mocked(source.load).mockResolvedValueOnce(original).mockResolvedValue(changed);
    vi.mocked(source.save).mockRejectedValue(new DataError('Tu perfil cambió.', 'PT409'));
    show(source);
    const input = await screen.findByRole('textbox', { name: 'Tu nombre' });
    await user.type(input, 'Mi borrador');
    await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
    const review = await screen.findByRole('button', { name: 'Revisar nombre actualizado' });
    expect(input).toHaveValue('Mi borrador');
    expect(screen.getByRole('button', { name: 'Guardar nombre' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Tu perfil cambió.');
    await user.click(review);
    expect(input).toHaveValue('Nombre elegido');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(source.save).toHaveBeenCalledExactlyOnceWith(original, 'Mi borrador');
  });

  it('confirms a lost save response only when a fresh read matches the submitted name', async () => {
    const user = userEvent.setup();
    const source = api();
    vi.mocked(source.load).mockResolvedValueOnce(original).mockResolvedValue(changed);
    vi.mocked(source.save).mockRejectedValue(new TypeError('Network failed'));
    show(source);
    await user.type(await screen.findByRole('textbox', { name: 'Tu nombre' }), 'Nombre elegido');
    await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Nombre confirmado');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(source.save).toHaveBeenCalledTimes(1);
  });

  it('resets the draft and ignores a save completed after the account scope changes', async () => {
    const user = userEvent.setup();
    const source = api();
    const saving = deferred<UserProfile>();
    vi.mocked(source.save).mockReturnValue(saving.promise);
    const view = show(source);
    await user.type(await screen.findByRole('textbox', { name: 'Tu nombre' }), 'Borrador anterior');
    await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
    const next = api();
    next.scopeKey = ['profile', 'owner-b', 'team-b'];
    vi.mocked(next.load).mockResolvedValue({ ...changed, user_id: 'owner-b', display_name: 'Otra cuenta' });
    view.change(next);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Otra cuenta'));
    await act(async () => saving.resolve(changed));
    expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Otra cuenta');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(view.client.getQueryData([...source.scopeKey, 'identity'])).toBeUndefined();
    expect(next.save).not.toHaveBeenCalled();
  });

  it('cancels an old profile read and ignores its late result after changing workspace', async () => {
    const source = api();
    const reading = deferred<UserProfile>();
    let signal: AbortSignal | undefined;
    vi.mocked(source.load).mockImplementation(value => {
      signal = value;
      return reading.promise;
    });
    const view = show(source);
    await waitFor(() => expect(source.load).toHaveBeenCalledOnce());
    const next = api();
    next.scopeKey = ['profile', 'owner-a', 'team-b'];
    vi.mocked(next.load).mockResolvedValue(changed);
    view.change(next);
    expect(await screen.findByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Nombre elegido');
    expect(signal?.aborted).toBe(true);
    await act(async () => reading.resolve(original));
    expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Nombre elegido');
    expect(view.client.getQueryData([...source.scopeKey, 'identity'])).toBeUndefined();
  });
});
