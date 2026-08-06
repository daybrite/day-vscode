import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// The extension's own documentation. Anything about the framework itself — installing the CLI,
// Day.toml, targets, dayscript — is linked to daybrite.dev rather than restated here, so there is
// one place for each fact.
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** Sidebar order, ascending. */
    order: z.number().default(99),
    section: z.string().default('Extension'),
  }),
});

export const collections = { docs };
