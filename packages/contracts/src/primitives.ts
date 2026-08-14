import { z } from "zod";

/** Shared leaf schemas reused across every contract in this package. */

export const isoTimestampSchema = z.string().datetime({ offset: true });

export const marketDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "date must be a valid calendar date");
