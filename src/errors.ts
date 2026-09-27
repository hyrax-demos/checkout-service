// Typed domain errors raised by the service layer. HTTP handlers map these to
// status codes; the service layer itself stays transport-agnostic.

// The requested resource does not exist, or is not visible to the caller.
// Deliberately indistinguishable between the two so another customer's
// resources are never revealed. Maps to 404.
export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

// The order exists but its current status does not allow cancellation.
// Maps to 409.
export class OrderNotCancellableError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(`order with status '${status}' cannot be cancelled`);
    this.name = "OrderNotCancellableError";
    this.status = status;
  }
}

// The payment processor rejected a money movement (e.g. a refund). Wraps the
// underlying `ProcessorError` as `cause`. Maps to 402.
export class PaymentFailedError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PaymentFailedError";
    this.cause = cause;
  }
}
