const messages: Record<string, string> = {
  invalid_credentials: 'El correo o la contraseña no son correctos.',
  email_not_confirmed: 'Confirma tu correo con el enlace que recibiste antes de iniciar sesión.',
  email_address_not_authorized: 'No se pudo enviar el correo a esta dirección. Revisa la configuración de envío del proyecto.',
  over_email_send_rate_limit: 'Se alcanzó el límite de correos. Espera unos minutos antes de volver a intentarlo.',
  over_request_rate_limit: 'Hay demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
  signup_disabled: 'La creación de cuentas está desactivada. Si tu cuenta ya existe, inicia sesión.',
  user_already_exists: 'Esta cuenta ya existe. Inicia sesión o recupera tu contraseña.',
  email_exists: 'Esta cuenta ya existe. Inicia sesión o recupera tu contraseña.',
  weak_password: 'Elige una contraseña más segura, de al menos 10 caracteres.',
  same_password: 'La contraseña nueva debe ser diferente de la actual.',
  otp_expired: 'El enlace ha caducado o ya se utilizó. Solicita uno nuevo.',
  session_not_found: 'La sesión ha caducado. Solicita un nuevo enlace de recuperación.',
  refresh_token_not_found: 'La sesión ha caducado. Solicita un nuevo enlace de recuperación.',
  refresh_token_already_used: 'La sesión ha caducado. Solicita un nuevo enlace de recuperación.',
  reauthentication_needed: 'Por seguridad necesitas un nuevo enlace de recuperación para cambiar la contraseña.',
};

export function authErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string' && messages[error.code]) return messages[error.code];
    if ('name' in error && error.name === 'AuthSessionMissingError') return messages.session_not_found;
    if ('message' in error && typeof error.message === 'string') {
      if (/failed to fetch|fetch failed|network|load failed/i.test(error.message)) {
        return 'No se pudo conectar. Comprueba tu conexión y vuelve a intentarlo.';
      }
      return error.message;
    }
  }
  return 'No se pudo completar la solicitud. Vuelve a intentarlo.';
}
