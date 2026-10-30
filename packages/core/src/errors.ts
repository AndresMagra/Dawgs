/**
 * Errors the API maps to status codes.
 *
 * Domain code throws these and never builds an HTTP response itself, so the
 * same rule ("a kennel can't hold two dogs on the same night") reads the same
 * from the web, the phone and the tests.
 */

export class DawgsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DawgsError';
  }
}

export class ValidationError extends DawgsError {
  constructor(message: string) {
    super('VALIDATION', message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends DawgsError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DawgsError {
  constructor(message: string) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

export class PaymentError extends DawgsError {
  constructor(
    message: string,
    readonly declineCode?: string,
  ) {
    super('PAYMENT_FAILED', message);
    this.name = 'PaymentError';
  }
}
