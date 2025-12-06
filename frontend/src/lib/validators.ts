import { z } from 'zod'


export const itemSchema = z.object({
name: z.string().min(1),
brand: z.string().optional().nullable(),
expiry_date: z.string().optional().nullable(),
mrp: z.coerce.number().nonnegative(),
stock: z.coerce.number().int().nonnegative()
})


export const billSchema = z.object({
items: z.array(z.object({ item_id: z.number().int(), quantity: z.number().positive(), mrp: z.number().nonnegative() })).min(1),
discount_percent: z.number().min(0).max(100).default(0),
tax_percent: z.number().min(0).max(100).default(0),
payment_mode: z.enum(['cash','online','split']),
payment_cash: z.number().optional(),
payment_online: z.number().optional(),
notes: z.string().optional()
})