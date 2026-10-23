// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupabaseClient } from '@supabase/supabase-js';
import AuthScreen from './AuthScreen';

const ownerEmail = 'owner@example.com';

function setup(recovery = false) {
  const auth = {
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session: { user: { email: ownerEmail } } }, error: null }),
    signUp: vi.fn().mockResolvedValue({ data: { user: { id: 'owner', identities: [{ id: 'email' }] }, session: null }, error: null }),
    resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
    updateUser: vi.fn().mockResolvedValue({ data: { user: { id: 'owner', email: ownerEmail } }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'owner', email: ownerEmail } }, error: null }),
  };
  const client = { auth } as unknown as SupabaseClient;
  const onRecoveryComplete = vi.fn();
  return { auth, client, onRecoveryComplete, recovery };
}

function show(config: ReturnType<typeof setup>) {
  render(<AuthScreen client={config.client} ownerEmail={ownerEmail} recovery={config.recovery} onRecoveryComplete={config.onRecoveryComplete} />);
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('autenticación personal', () => {
  it('permite entrar con otra cuenta habilitada y no ofrece altas externas', async () => {
    const config = setup();
    const user = show(config);
    expect(screen.getByLabelText('Correo electrónico')).not.toHaveAttribute('readonly');
    expect(config.auth.signUp).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Crear mi cuenta' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Correo electrónico'));
    await user.type(screen.getByLabelText('Correo electrónico'), 'member@example.com');
    await user.type(screen.getByLabelText('Contraseña', { exact: true }), 'su-contraseña');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(config.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'member@example.com', password: 'su-contraseña' });
    expect(config.auth.signUp).not.toHaveBeenCalled();
  });

  it('muestra el error del servidor de login y permite corregir la contraseña', async () => {
    const config = setup();
    config.auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { code: 'invalid_credentials' } });
    const user = show(config);
    await user.type(screen.getByLabelText('Contraseña', { exact: true }), 'contraseña-incorrecta');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El correo o la contraseña no son correctos.');
    expect(config.auth.signInWithPassword).toHaveBeenCalledWith({ email: ownerEmail, password: 'contraseña-incorrecta' });
    expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled();
  });

  it('recupera la cuenta verificada por el servidor aunque no coincida con el correo inicial', async () => {
    const config = setup(true);
    config.auth.getUser.mockResolvedValue({ data: { user: { id: 'member', email: 'member@example.com' } }, error: null });
    show(config);
    expect(await screen.findByLabelText('Nueva contraseña')).toBeInTheDocument();
    expect(screen.getByLabelText('Correo electrónico')).toHaveValue('member@example.com');
  });

  it('no informa un correo enviado si Supabase rechaza la solicitud', async () => {
    const config = setup();
    config.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: { code: 'over_email_send_rate_limit' } });
    const user = show(config);
    await user.click(screen.getByRole('button', { name: '¿Olvidaste tu contraseña?' }));
    await user.click(screen.getByRole('button', { name: 'Enviar enlace de recuperación' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Se alcanzó el límite de correos.');
    expect(screen.queryByRole('heading', { name: 'Revisa tu correo' })).not.toBeInTheDocument();
    expect(config.auth.resetPasswordForEmail).toHaveBeenCalledWith(ownerEmail, { redirectTo: `${window.location.origin}/?auth=recovery` });
  });

  it('bloquea una recuperación sin usuario válido y limpia la sesión antes de salir', async () => {
    const config = setup(true);
    config.auth.getUser.mockResolvedValue({ data: { user: null }, error: { code: 'session_not_found' } });
    const user = show(config);
    expect(await screen.findByRole('heading', { name: 'Necesitas un nuevo enlace' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Nueva contraseña')).not.toBeInTheDocument();
    expect(config.auth.updateUser).not.toHaveBeenCalled();
    expect(config.onRecoveryComplete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Solicitar nuevo enlace' }));
    await waitFor(() => expect(config.onRecoveryComplete).toHaveBeenCalledOnce());
    expect(config.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('rechaza un callback con error aunque haya una sesión anterior', async () => {
    window.history.replaceState({}, '', '/?auth=recovery#error=access_denied&error_code=otp_expired');
    const config = setup(true);
    show(config);
    expect(await screen.findByRole('heading', { name: 'Necesitas un nuevo enlace' })).toBeInTheDocument();
    expect(config.auth.getUser).not.toHaveBeenCalled();
    expect(config.auth.updateUser).not.toHaveBeenCalled();
  });

  it('actualiza la contraseña y termina la sesión de recuperación antes de continuar', async () => {
    const config = setup(true);
    const user = show(config);
    await user.type(await screen.findByLabelText('Nueva contraseña'), 'una-contraseña-nueva');
    await user.type(screen.getByLabelText('Repite la contraseña'), 'una-contraseña-nueva');
    await user.click(screen.getByRole('button', { name: 'Guardar nueva contraseña' }));
    await waitFor(() => expect(config.onRecoveryComplete).toHaveBeenCalledOnce());
    expect(config.auth.updateUser).toHaveBeenCalledWith({ password: 'una-contraseña-nueva' });
    expect(config.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(config.auth.signInWithPassword).not.toHaveBeenCalled();
  });
});
