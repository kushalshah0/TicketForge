import { jest } from '@jest/globals';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

describe('CatalogController', () => {
  it('passes the authenticated organizer ID and draft input to the service', async () => {
    const createDraft = jest
      .fn<(organizerId: string, input: unknown) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'event-1' });
    const service = { createDraft } as unknown as CatalogService;
    const catalogController = new CatalogController(service);
    const input = { title: 'Concert' };

    await expect(
      catalogController.createDraft(
        { sub: 'organizer-1', role: 'organizer' },
        input,
      ),
    ).resolves.toEqual({
      id: 'event-1',
    });

    expect(createDraft).toHaveBeenCalledWith('organizer-1', input);
  });
});
