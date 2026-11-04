import { json, type NextFunction, type Request, type Response } from 'express';

/**
 * JSON body limits: 100 kB for every request, except a fee payment that carries its screenshot proof. The client
 * marks that one request with `x-upload: fee-proof`; the image itself is checked again in FeesService (type, size).
 */
export function jsonBodyLimits() {
  const small = json({ limit: '100kb' });
  const upload = json({ limit: '800kb' });
  return (req: Request, res: Response, next: NextFunction) => (req.headers['x-upload'] === 'fee-proof' && req.path === '/graphql' ? upload : small)(req, res, next);
}
