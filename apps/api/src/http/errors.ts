import type { ErrorCode } from "@private-chat/contracts";

export interface ApiHttpError {
  status: number;
  code: ErrorCode;
  message: string;
}

export function httpError(status: number, code: ErrorCode, message: string): ApiHttpError {
  return { status, code, message };
}

export const ERRORS = {
  unauthenticated: () => httpError(401, "UNAUTHENTICATED", "Inicia sesión para continuar"),
  forbidden: () => httpError(403, "FORBIDDEN", "No tienes permiso para esta acción"),
  passwordChangeRequired: () =>
    httpError(403, "PASSWORD_CHANGE_REQUIRED", "Debes cambiar tu contraseña para continuar"),
  invalidCredentials: () => httpError(401, "INVALID_CREDENTIALS", "Credenciales no válidas"),
  pinLocked: () => httpError(403, "PIN_LOCKED", "Código bloqueado por demasiados intentos. Espera unos minutos"),
  pinRequired: () => httpError(403, "PIN_REQUIRED", "Esta cuenta usa código de 4 dígitos"),
  rateLimited: () => httpError(429, "RATE_LIMITED", "Demasiados intentos. Inténtalo más tarde"),
  validation: (message = "Datos no válidos") => httpError(400, "VALIDATION_ERROR", message),
  usernameTaken: () => httpError(409, "USERNAME_TAKEN", "Ese nombre de usuario ya está en uso"),
  conversationChanged: () =>
    httpError(409, "CONVERSATION_CHANGED", "La conversación cambió. Actualiza e inténtalo de nuevo"),
  messageNotFound: () => httpError(404, "MESSAGE_NOT_FOUND", "Mensaje no encontrado"),
  messageDeleted: () => httpError(410, "MESSAGE_DELETED", "El mensaje fue eliminado"),
  uploadInvalid: (message = "Archivo no válido") => httpError(400, "UPLOAD_INVALID", message),
  csrfInvalid: () => httpError(403, "CSRF_INVALID", "Sesión no válida. Recarga la página"),
  idempotencyConflict: () =>
    httpError(409, "IDEMPOTENCY_CONFLICT", "Ese identificador ya se usó con otro contenido"),
  unavailable: () => httpError(503, "SERVICE_UNAVAILABLE", "Servicio no disponible. Inténtalo más tarde"),
  internal: () => httpError(500, "INTERNAL_ERROR", "Error interno. Inténtalo más tarde"),
} as const;

export function errorBody(err: ApiHttpError): { error: { code: ErrorCode; message: string } } {
  return { error: { code: err.code, message: err.message } };
}
