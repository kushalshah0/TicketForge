import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { DrizzleDatabase } from '@tf/common';
import type { Pool } from 'pg';
import { OutboxService } from '@tf/outbox';
import { CatalogService } from './catalog.service';

describe('CatalogService', () => {
  const returning = jest.fn<() => Promise<unknown[]>>();
  const values = jest.fn<(input: unknown) => { returning: typeof returning }>();
  const insert = jest.fn<() => { values: typeof values }>();
  const pool = { end: jest.fn<() => Promise<void>>() } as unknown as Pool;
  const database = { insert } as unknown as DrizzleDatabase;
  let service: CatalogService;
  let originalRedisUrl: string | undefined;

  beforeEach(() => {
    jest.resetAllMocks();
    originalRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    insert.mockReturnValue({ values });
    values.mockReturnValue({ returning });
    service = new CatalogService(database, pool, {} as OutboxService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('validates and applies event draft defaults before inserting', async () => {
    const organizerId = 'c0a80123-4567-489a-8abc-123456789abc';
    const event = {
      id: 'c0a80123-4567-489a-8abc-123456789abd',
      title: 'Concert',
      startsAt: new Date('2027-01-01T10:00:00.000Z'),
    };
    returning.mockResolvedValue([event]);

    await expect(
      service.createDraft(organizerId, {
        title: ' Concert ',
        venueName: ' Hall ',
        city: ' Kathmandu ',
        startsAt: '2027-01-01T10:00:00.000Z',
      }),
    ).resolves.toBe(event);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizerId,
        title: 'Concert',
        venueName: 'Hall',
        city: 'Kathmandu',
        description: '',
        currency: 'NPR',
        layout: { sections: [] },
        tiers: [],
        startsAt: new Date('2027-01-01T10:00:00.000Z'),
      }),
    );
  });

  it('rejects invalid draft input and organizer IDs before inserting', async () => {
    await expect(service.createDraft('not-a-uuid', {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await expect(
      service.createDraft('not-a-uuid', {
        title: 'Concert',
        venueName: 'Hall',
        city: 'Kathmandu',
        startsAt: '2027-01-01T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    expect(values).not.toHaveBeenCalled();
  });

  it('surfaces an insert that returns no event row', async () => {
    returning.mockResolvedValue([]);

    await expect(
      service.createDraft('c0a80123-4567-489a-8abc-123456789abc', {
        title: 'Concert',
        venueName: 'Hall',
        city: 'Kathmandu',
        startsAt: '2027-01-01T10:00:00.000Z',
      }),
    ).rejects.toThrow('Catalog event insert returned no row');
  });
});
