import { randomUUID } from 'node:crypto';
import {
  catalogLayoutAndTiersSchema,
  catalogLayoutSchema,
} from './catalog.schemas';

const tierId = randomUUID();

function eventShape(rows = 2, seatsPerRow = 10) {
  return {
    tiers: [{ id: tierId, name: 'Standard', priceMinor: 1200 }],
    layout: {
      sections: [{ id: randomUUID(), name: 'Main', tierId, rows, seatsPerRow }],
    },
  };
}

describe('catalog layout and tier schemas', () => {
  it('accepts a valid layout and tier set', () => {
    expect(catalogLayoutAndTiersSchema.safeParse(eventShape()).success).toBe(
      true,
    );
  });

  it('rejects an empty layout', () => {
    expect(catalogLayoutSchema.safeParse({ sections: [] }).success).toBe(false);
  });

  it('rejects more than 26 rows', () => {
    expect(
      catalogLayoutSchema.safeParse({
        sections: eventShape(27).layout.sections,
      }).success,
    ).toBe(false);
  });

  it('rejects a section that references an unknown tier', () => {
    const input = eventShape();
    input.layout.sections[0].tierId = randomUUID();
    expect(catalogLayoutAndTiersSchema.safeParse(input).success).toBe(false);
  });

  it('rejects layouts exceeding 500 seats', () => {
    const input = eventShape(13, 40);
    expect(catalogLayoutAndTiersSchema.safeParse(input).success).toBe(false);
  });

  it('rejects negative or fractional prices', () => {
    const input = eventShape();
    input.tiers[0].priceMinor = -1.5;
    expect(catalogLayoutAndTiersSchema.safeParse(input).success).toBe(false);
  });
});
