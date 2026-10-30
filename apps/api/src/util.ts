import { z } from 'zod';
import { ValidationError } from '@dawgs/core';

/** Validate a request body or query; a failure is a 400 with the first problem in words. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new ValidationError(`${i.path.join('.') || 'input'}: ${i.message}`);
  }
  return r.data;
}

export const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM');
export const uuid = z.string().uuid();
export const cents = z.number().int().min(0);

export const walletShape = z.object({
  daycare: z.number().int().min(0).optional(),
  night: z.number().int().min(0).optional(),
  walk: z.number().int().min(0).optional(),
  bath: z.number().int().min(0).optional(),
});

/** How a sale is settled at the counter or in the app. */
export const payShape = z.discriminatedUnion('method', [
  z.object({ method: z.literal('card'), paymentMethodId: uuid.optional() }),
  z.object({ method: z.literal('cash') }),
  z.object({ method: z.literal('later') }),
]);
export type PayInput = z.infer<typeof payShape>;
