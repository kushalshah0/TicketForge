import { z } from 'zod';

const uuid = z.string().uuid();

export const catalogTierSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1),
  priceMinor: z.number().int().nonnegative(),
});

export const catalogSectionSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1),
  tierId: uuid,
  rows: z.number().int().min(1).max(26),
  seatsPerRow: z.number().int().min(1).max(40),
});

export const catalogLayoutSchema = z.object({
  sections: z.array(catalogSectionSchema).min(1),
});

export const catalogLayoutAndTiersSchema = z
  .object({
    layout: catalogLayoutSchema,
    tiers: z.array(catalogTierSchema),
  })
  .superRefine(({ layout, tiers }, context) => {
    const tierIds = new Set(tiers.map((tier) => tier.id));
    let totalSeats = 0;

    for (const [index, section] of layout.sections.entries()) {
      totalSeats += section.rows * section.seatsPerRow;
      if (!tierIds.has(section.tierId)) {
        context.addIssue({
          code: 'custom',
          path: ['layout', 'sections', index, 'tierId'],
          message: 'Section references an unknown tier',
        });
      }
    }

    if (totalSeats > 500) {
      context.addIssue({
        code: 'custom',
        path: ['layout', 'sections'],
        message: 'An event cannot have more than 500 seats',
      });
    }
  });

export type CatalogTier = z.infer<typeof catalogTierSchema>;
export type CatalogSectionInput = z.infer<typeof catalogSectionSchema>;
export type CatalogLayout = z.infer<typeof catalogLayoutSchema>;

const draftLayoutSchema = z.object({ sections: z.array(catalogSectionSchema) });
const draftFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  venueName: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(120),
  startsAt: z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value)),
  currency: z.string().regex(/^[A-Z]{3}$/),
  layout: draftLayoutSchema,
  tiers: z.array(catalogTierSchema),
};

export const createCatalogEventSchema = z.object({
  ...draftFields,
  description: draftFields.description.optional().default(''),
  currency: draftFields.currency.optional().default('NPR'),
  layout: draftFields.layout.optional().default({ sections: [] }),
  tiers: draftFields.tiers.optional().default([]),
});

export const updateCatalogEventSchema = z
  .object(draftFields)
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required',
  );

export const catalogSearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  city: z.string().trim().max(120).optional(),
  from: z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
  to: z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CatalogSearch = z.infer<typeof catalogSearchSchema>;
