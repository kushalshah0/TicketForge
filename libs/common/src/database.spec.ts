import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { createPgPool } from './database';

describe('createPgPool', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs idle-client errors instead of emitting an unhandled pool error', async () => {
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const pool = createPgPool();
    const error = Object.assign(new Error('connection terminated'), {
      code: '57P01',
    });

    try {
      expect(() => pool.emit('error', error)).not.toThrow();
      expect(logError).toHaveBeenCalledWith(
        'Idle PostgreSQL client error (code=57P01)',
      );
    } finally {
      await pool.end();
    }
  });
});
