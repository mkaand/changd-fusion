export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function publicFailure(e: unknown): string {
  if (e instanceof HttpError && e.status < 500) return e.message;
  return "Operation failed. Check configuration and retry.";
}
