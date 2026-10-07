/**
 * Typed application error.
 *
 * Routes throw `AppError`; the global error handler turns it into a stable
 * JSON envelope. `code` is machine readable so the web client can branch on
 * failures (e.g. `INVENTORY_EXPIRED` should send the shopper back to search).
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVENTORY_UNAVAILABLE'
  | 'INVENTORY_EXPIRED'
  | 'PRICE_CHANGED'
  | 'EMAIL_NOT_VERIFIED'
  | 'PAYMENT_FAILED'
  | 'TICKET_ALREADY_REDEEMED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static validation(message: string, details?: unknown) {
    return new AppError(422, 'VALIDATION_FAILED', message, details);
  }

  static unauthenticated(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(resource = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${resource} not found`);
  }

  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }

  static inventoryUnavailable(message = 'This option is no longer available', details?: unknown) {
    return new AppError(409, 'INVENTORY_UNAVAILABLE', message, details);
  }

  static inventoryExpired(message = 'Your hold expired, please re-select your options') {
    return new AppError(409, 'INVENTORY_EXPIRED', message);
  }

  static priceChanged(message: string, details?: unknown) {
    return new AppError(409, 'PRICE_CHANGED', message, details);
  }

  /**
   * Checkout is blocked until the shopper confirms their email address.
   *
   * 403 rather than 409: the request is well-formed and the cart is valid —
   * what is missing is a precondition on the *account*, and the client's fix is
   * to verify, not to re-select. The web client branches on the code to show a
   * "verify your email" call to action instead of a generic error.
   */
  static emailNotVerified(message = 'Please verify your email address to continue') {
    return new AppError(403, 'EMAIL_NOT_VERIFIED', message);
  }

  static paymentFailed(message: string, details?: unknown) {
    return new AppError(402, 'PAYMENT_FAILED', message, details);
  }
}

export function assertFound<T>(value: T | null | undefined, resource = 'Resource'): T {
  if (value === null || value === undefined) throw AppError.notFound(resource);
  return value;
}