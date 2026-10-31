import { z } from 'zod';
import type { CourierId } from '../domain/types.js';
import { PathaoAdapter } from './pathao.js';
import { RedxAdapter } from './redx.js';
import { SteadfastAdapter } from './steadfast.js';
import type { CourierAdapter } from './types.js';

export const courierCredentialSchemas = {
  steadfast: z.object({ apiKey: z.string().min(1), secretKey: z.string().min(1) }),
  pathao: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    storeId: z.coerce.number().int().positive(),
  }),
  redx: z.object({ accessToken: z.string().min(1), pickupStoreId: z.coerce.number().int().positive() }),
} as const;

export interface CourierFactoryOptions {
  sandbox: boolean;
  fetch?: typeof fetch;
}

/** Builds an adapter from a seller's stored (decrypted) credentials. Throws a ZodError on bad credentials. */
export function createCourierAdapter(id: CourierId, credentials: unknown, opts: CourierFactoryOptions): CourierAdapter {
  switch (id) {
    case 'steadfast':
      return new SteadfastAdapter(courierCredentialSchemas.steadfast.parse(credentials), { fetch: opts.fetch });
    case 'pathao':
      return new PathaoAdapter(courierCredentialSchemas.pathao.parse(credentials), {
        sandbox: opts.sandbox,
        fetch: opts.fetch,
      });
    case 'redx':
      return new RedxAdapter(courierCredentialSchemas.redx.parse(credentials), {
        sandbox: opts.sandbox,
        fetch: opts.fetch,
      });
  }
}
