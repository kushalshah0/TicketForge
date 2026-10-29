import { loadConfig } from './config';
import { z } from 'zod';

describe('loadConfig', () => {
  it('returns parsed values with defaults applied', () => {
    const schema = z.object({
      PORT: z.coerce.number().default(3000),
      NODE_ENV: z.enum(['development', 'production']).default('development'),
    });

    expect(loadConfig(schema, {})).toEqual({
      PORT: 3000,
      NODE_ENV: 'development',
    });
  });

  it('names invalid fields in the error', () => {
    const schema = z.object({ DATABASE_URL: z.string().url() });

    expect(() => loadConfig(schema, {})).toThrow(
      'Invalid environment configuration: DATABASE_URL: Required',
    );
  });
});
