import { z } from 'zod';
import { FormatSchema } from './common';

export const QueryInput = z.object({
  question: z.string().min(3).max(500),
  format: FormatSchema,
});
