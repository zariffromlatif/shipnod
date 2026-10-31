export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
