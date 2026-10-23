import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ArrowLeft, CheckCircle2, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, MailCheck } from 'lucide-react';
import { authErrorMessage } from './errors';
import './auth.css';

export interface AuthScreenProps {
  client: SupabaseClient;
  ownerEmail: string;
  recovery: boolean;
  onRecoveryComplete: () => void;
}

type Mode = 'login' | 'signup' | 'forgot' | 'verify' | 'sent';
type RecoveryStatus = 'checking' | 'ready' | 'invalid' | 'updated';
type FieldErrors = { password?: string; confirmation?: string };

const LOGO_PATH =
  'M99.1462 184.663C94.0907 182.417 85.7476 181.12 76.352 179.822C69.5385 178.874 67.8899 178.404 67.8899 176.278C67.8899 174.392 69.5385 173.683 76.938 173.563C99.2654 173.323 105.374 167.424 105.374 156.324C105.374 150.894 103.496 146.521 97.9742 144.275L107.251 142.508L107.489 131.049H79.5204C52.3857 131.049 47.9163 142.508 47.9163 152.421C47.9163 160.337 49.7935 166.596 57.7888 170.139C49.5649 171.557 46.6251 174.621 46.6251 179.942C46.6251 188.207 55.435 189.744 67.3039 191.511C76.819 192.929 86.1055 192.809 86.1055 197.65C86.1055 200.255 83.9899 202.372 77.8816 202.372C68.4759 202.372 67.7707 199.067 67.5423 195.174H46.0391C46.0391 209.579 53.091 216.546 77.7624 216.546C101.967 216.546 107.837 206.983 107.837 197.061C107.837 190.562 104.907 187.029 99.1462 184.663ZM67.5818 145.663H84.7049V161.744H67.5818V145.663Z M131.104 138.36L127.469 131.033H115.133V191.256H137.222V161.27C137.222 153.593 138.98 147.684 152.021 149.101V129.975C140.271 128.907 134.749 132.451 131.104 138.36Z M210.119 152.285C217.757 150.398 223.041 145.207 223.041 136.113C223.041 123.117 214.698 114.502 191.903 114.502C169.109 114.502 160.766 123.117 160.766 136.113C160.766 145.207 166.06 150.398 173.697 152.285C164.878 154.77 159.355 161.029 159.355 170.243C159.355 182.76 167.699 192.443 192.022 192.443C216.108 192.443 224.451 182.76 224.451 170.243C224.451 161.029 218.929 154.77 210.119 152.285ZM204.03 176.172H180.193V160.091H204.03V176.172ZM204.03 144.029H180.193V130.553H204.03V144.029Z M247.211 138.36L243.566 131.033H231.23V191.256H253.32V161.27C253.32 153.593 255.088 147.684 268.128 149.101V129.975C256.379 128.907 250.856 132.451 247.211 138.36Z M284.807 114.502H267.684V130.583H284.807V114.502Z';

function Brand({ height = 22 }: { height?: number }) {
  return (
    <svg height={height} width={Math.round((height * 241.47) / 102.27)} viewBox="45.53 114.5 241.47 102.27" role="img" aria-label="Gr8r">
      <path d={LOGO_PATH} fill="currentColor" />
    </svg>
  );
}

export default function AuthScreen({ client, ownerEmail, recovery, onRecoveryComplete }: AuthScreenProps) {
  const email = ownerEmail.trim().toLowerCase();
  const configured = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const [mode, setMode] = useState<Mode>('login');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>('checking');
  const busy = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recovery) return;
    let active = true;
    setRecoveryStatus('checking');
    setError(null);
    setNotice(null);
    setPassword('');
    setConfirmation('');
    setFieldErrors({});
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    if (parameters.has('error') || query.has('error')) {
      setRecoveryStatus('invalid');
      setError('El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo.');
      return;
    }
    void client.auth
      .getUser()
      .then(({ data, error: sessionError }) => {
        if (!active) return;
        if (sessionError || !data.user || data.user.email?.toLowerCase() !== email) {
          setRecoveryStatus('invalid');
          setError('El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo.');
          return;
        }
        setRecoveryStatus('ready');
      })
      .catch(cause => {
        if (!active) return;
        setRecoveryStatus('invalid');
        setError(authErrorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [client, email, recovery]);

  function switchMode(next: Mode) {
    if (busy.current) return;
    setMode(next);
    setPassword('');
    setConfirmation('');
    setShowPassword(false);
    setFieldErrors({});
    setError(null);
    setNotice(null);
  }

  async function leaveRecovery(next: Mode) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      setMode(next);
      setPassword('');
      setConfirmation('');
      setFieldErrors({});
      if (recoveryStatus === 'updated') setNotice('Contraseña actualizada. Inicia sesión con tu nueva contraseña.');
      onRecoveryComplete();
    } catch (cause) {
      setError(authErrorMessage(cause));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !configured || (recovery && recoveryStatus !== 'ready')) return;
    setError(null);
    setNotice(null);
    const errors: FieldErrors = {};
    if (recovery || mode === 'signup') {
      if (password.length < 10) errors.password = 'Usa al menos 10 caracteres.';
      if (password !== confirmation) errors.confirmation = 'Las contraseñas no coinciden.';
    } else if (mode === 'login' && !password) {
      errors.password = 'Introduce tu contraseña.';
    }
    setFieldErrors(errors);
    if (errors.password || errors.confirmation) {
      (errors.password ? passwordInput : confirmationInput).current?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      if (recovery) {
        const { data, error: updateError } = await client.auth.updateUser({ password });
        if (updateError) throw updateError;
        if (!data.user) throw new Error('No se pudo confirmar el cambio de contraseña. Solicita un nuevo enlace.');
        setPassword('');
        setConfirmation('');
        setRecoveryStatus('updated');
        const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
        if (signOutError) throw signOutError;
        setMode('login');
        setNotice('Contraseña actualizada. Inicia sesión con tu nueva contraseña.');
        onRecoveryComplete();
      } else if (mode === 'login') {
        const { data, error: loginError } = await client.auth.signInWithPassword({ email, password });
        if (loginError) throw loginError;
        if (!data.session) throw new Error('No se pudo iniciar la sesión. Vuelve a intentarlo.');
        setPassword('');
      } else if (mode === 'signup') {
        const { data, error: signupError } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/` },
        });
        if (signupError) throw signupError;
        if (data.user?.identities?.length === 0) throw new Error('Esta cuenta ya existe. Inicia sesión o recupera tu contraseña.');
        setPassword('');
        setConfirmation('');
        if (!data.session) setMode('verify');
      } else if (mode === 'forgot') {
        const { error: resetError } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/?auth=recovery`,
        });
        if (resetError) throw resetError;
        setMode('sent');
      }
    } catch (cause) {
      setError(authErrorMessage(cause));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const isPasswordForm = recovery ? recoveryStatus === 'ready' : mode === 'login' || mode === 'signup';
  const needsConfirmation = recovery || mode === 'signup';
  const heading = recovery
    ? recoveryStatus === 'invalid'
      ? 'Necesitas un nuevo enlace'
      : recoveryStatus === 'updated'
        ? 'Contraseña actualizada'
        : 'Elige una nueva contraseña'
    : {
        login: 'Bienvenido de nuevo',
        signup: 'Crea tu cuenta personal',
        forgot: 'Recupera tu contraseña',
        verify: 'Confirma tu correo',
        sent: 'Revisa tu correo',
      }[mode];
  const description = recovery
    ? recoveryStatus === 'updated'
      ? 'Cierra esta sesión para entrar con tu nueva contraseña.'
      : 'Recupera el acceso a tu espacio personal.'
    : {
        login: 'Tus proyectos y tareas, en un solo lugar.',
        signup: 'Configura tu contraseña para empezar.',
        forgot: 'Te enviaremos un enlace para elegir una contraseña nueva.',
        verify: 'Revisa tu bandeja de entrada y abre el enlace de confirmación. Después podrás iniciar sesión.',
        sent: 'Si tu cuenta está creada, recibirás un enlace de recuperación. Revisa también la carpeta de spam.',
      }[mode];

  return (
    <div className="auth personal-auth">
      <header className="auth-top">
        <span className="brand">
          <Brand />
        </span>
        <span className="personal-auth-private">
          <LockKeyhole size={13} aria-hidden="true" /> Espacio personal
        </span>
      </header>
      <main className="auth-c">
        <form className="auth-card" onSubmit={submit} noValidate aria-labelledby="auth-title" aria-busy={pending}>
          <div className="personal-auth-mark">
            {recovery ? (
              recoveryStatus === 'updated' ? (
                <CheckCircle2 size={26} aria-hidden="true" />
              ) : (
                <KeyRound size={26} aria-hidden="true" />
              )
            ) : mode === 'verify' || mode === 'sent' ? (
              <MailCheck size={26} aria-hidden="true" />
            ) : (
              <Brand height={30} />
            )}
          </div>
          <h1 id="auth-title">{heading}</h1>
          <p className="sub">{description}</p>
          {!configured ? (
            <div className="alert danger" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <span>Falta configurar el correo de la cuenta propietaria.</span>
            </div>
          ) : null}
          {error ? (
            <div className="alert danger" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div className="alert ok" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{notice}</span>
            </div>
          ) : null}
          {recovery && recoveryStatus === 'checking' ? (
            <p className="personal-auth-status" role="status">
              <LoaderCircle size={16} className="personal-auth-spin" aria-hidden="true" /> Verificando enlace…
            </p>
          ) : null}
          {(!recovery || recoveryStatus === 'ready') && mode !== 'verify' && mode !== 'sent' ? (
            <div className="field">
              <label className="label" htmlFor="auth-email">
                Correo electrónico
              </label>
              <input
                id="auth-email"
                className="input input-lg personal-auth-email"
                type="email"
                value={email}
                readOnly
                autoComplete="username"
                aria-describedby="auth-account-hint"
              />
              <span className="hint" id="auth-account-hint">
                Cuenta personal de este espacio.
              </span>
            </div>
          ) : !recovery && (mode === 'verify' || mode === 'sent') ? (
            <p className="personal-auth-address">{email}</p>
          ) : null}
          {isPasswordForm ? (
            <>
              <div className="field">
                <div className="row">
                  <label className="label" htmlFor="auth-password">
                    {needsConfirmation ? 'Nueva contraseña' : 'Contraseña'}
                  </label>
                  {mode === 'login' && !recovery ? (
                    <button type="button" className="link personal-auth-forgot" disabled={pending} onClick={() => switchMode('forgot')}>
                      ¿Olvidaste tu contraseña?
                    </button>
                  ) : null}
                </div>
                <div className="personal-auth-password">
                  <input
                    ref={passwordInput}
                    id="auth-password"
                    className={`input input-lg${fieldErrors.password ? ' is-error' : ''}`}
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    autoComplete={needsConfirmation ? 'new-password' : 'current-password'}
                    required
                    minLength={needsConfirmation ? 10 : undefined}
                    disabled={pending}
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={fieldErrors.password ? 'auth-password-error' : needsConfirmation ? 'auth-password-hint' : undefined}
                  />
                  <button
                    type="button"
                    className="ibtn ibtn-sm"
                    aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(value => !value)}
                  >
                    {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  </button>
                </div>
                {fieldErrors.password ? (
                  <span className="err" id="auth-password-error">
                    {fieldErrors.password}
                  </span>
                ) : needsConfirmation ? (
                  <span className="hint" id="auth-password-hint">
                    Al menos 10 caracteres. Usa una contraseña única.
                  </span>
                ) : null}
              </div>
              {needsConfirmation ? (
                <div className="field">
                  <label className="label" htmlFor="auth-confirmation">
                    Repite la contraseña
                  </label>
                  <input
                    ref={confirmationInput}
                    id="auth-confirmation"
                    className={`input input-lg${fieldErrors.confirmation ? ' is-error' : ''}`}
                    type={showPassword ? 'text' : 'password'}
                    value={confirmation}
                    onChange={event => setConfirmation(event.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={10}
                    disabled={pending}
                    aria-invalid={Boolean(fieldErrors.confirmation)}
                    aria-describedby={fieldErrors.confirmation ? 'auth-confirmation-error' : undefined}
                  />
                  {fieldErrors.confirmation ? (
                    <span className="err" id="auth-confirmation-error">
                      {fieldErrors.confirmation}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {isPasswordForm || (!recovery && mode === 'forgot') ? (
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending || !configured}>
              {pending ? <LoaderCircle size={16} className="personal-auth-spin" aria-hidden="true" /> : null}
              {pending
                ? 'Procesando…'
                : recovery
                  ? 'Guardar nueva contraseña'
                  : mode === 'login'
                    ? 'Iniciar sesión'
                    : mode === 'signup'
                      ? 'Crear mi cuenta'
                      : 'Enviar enlace de recuperación'}
            </button>
          ) : null}
          {recovery && recoveryStatus !== 'checking' ? (
            <button
              type="button"
              className={`btn ${recoveryStatus === 'updated' || recoveryStatus === 'invalid' ? 'btn-primary' : 'btn-secondary'} btn-lg btn-block`}
              disabled={pending}
              onClick={() => void leaveRecovery(recoveryStatus === 'invalid' ? 'forgot' : 'login')}
            >
              {pending ? <LoaderCircle size={16} className="personal-auth-spin" aria-hidden="true" /> : null}
              {recoveryStatus === 'updated' ? 'Continuar al inicio de sesión' : recoveryStatus === 'invalid' ? 'Solicitar nuevo enlace' : 'Cancelar y volver'}
            </button>
          ) : null}
          {!recovery && mode === 'login' ? (
            <p className="auth-foot">
              ¿Es tu primera vez?{' '}
              <button type="button" className="link" disabled={pending} onClick={() => switchMode('signup')}>
                Crear mi cuenta
              </button>
            </p>
          ) : null}
          {!recovery && mode !== 'login' ? (
            <p className="auth-foot">
              <button type="button" className="link personal-auth-back" disabled={pending} onClick={() => switchMode('login')}>
                <ArrowLeft size={14} aria-hidden="true" /> Volver a iniciar sesión
              </button>
            </p>
          ) : null}
          <span className="sr" aria-live="polite">
            {pending ? 'Solicitud en curso. Espera un momento.' : ''}
          </span>
        </form>
      </main>
      <footer className="auth-foot personal-auth-footer">© {new Date().getFullYear()} Gr8r Studio</footer>
    </div>
  );
}
