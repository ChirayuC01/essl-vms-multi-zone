/**
 * A refusal the caller can act on, carrying the HTTP status the API should
 * answer with. Service functions throw these so the same rule is enforced
 * whether the caller is a route handler, a scheduled job, or a script — the
 * rules must not live in the UI or in one transport.
 */
export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
