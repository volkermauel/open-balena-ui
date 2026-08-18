/**
 * Typed error for OS image operations. The `statusCode` is used by the route layer to map
 * controller failures onto HTTP responses with the standard `{ success: false, message }` shape.
 */
export class OsImageError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'OsImageError';
    this.statusCode = statusCode;
  }
}

export const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;
