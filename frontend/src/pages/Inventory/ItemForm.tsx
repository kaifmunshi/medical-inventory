// F:\medical-inventory\frontend\src\pages\Inventory\ItemForm.tsx
import { Drawer, Stack, TextField, Button, Typography, Autocomplete } from '@mui/material'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { itemSchema } from '../../lib/validators'
import { z } from 'zod'
import React from 'react'

export type ItemFormValues = z.infer<typeof itemSchema>

type ItemFormProps = {
  open: boolean
  initial?: Partial<ItemFormValues> | null
  onClose: () => void
  onSubmit: (values: ItemFormValues) => void
  items?: any[]                    // 🔹 list of existing items for search
}

export default function ItemForm({
  open,
  initial,
  onClose,
  onSubmit,
  items = [],
}: ItemFormProps) {
  // YYYY-MM-DD for today's date (used to block past expiries; remove if not needed)
  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), [])

  const {
    register,
    handleSubmit,
    reset,
    getValues, 
    formState: { errors, isSubmitting },
  } = useForm<ItemFormValues>({
    resolver: zodResolver(itemSchema),
    defaultValues: {
      name: initial?.name ?? '',
      brand: (initial?.brand as any) ?? '',
      expiry_date: (initial?.expiry_date as any) ?? '', // expects "YYYY-MM-DD"
      mrp: Number(initial?.mrp ?? 0),
      stock: Number(initial?.stock ?? 0),
    },
  })

  // reset when `initial` changes
 // 1️⃣ When editing an item: fill form from `initial`
React.useEffect(() => {
  if (!initial) return           // if we're adding, do nothing here

  reset({
    name: initial.name ?? '',
    brand: (initial.brand as any) ?? '',
    expiry_date: (initial.expiry_date as any) ?? '',
    mrp: Number(initial.mrp ?? 0),
    stock: Number(initial.stock ?? 0),
  })
}, [initial, reset])

// 2️⃣ When opening in "Add Item" mode: clear the form every time
React.useEffect(() => {
  if (open && !initial) {
    reset({
      name: '',
      brand: '',
      expiry_date: '',
      mrp: '' as any,
      stock: '' as any,
    })
  }
}, [open, initial, reset])


  // helper to pre-fill from an existing item
  function applyFromExisting(it: any) {
    if (!it) return
    reset({
      name: it.name ?? '',
      brand: it.brand ?? '',
      expiry_date: '',
      mrp: Number(it.mrp ?? 0),
      stock: '' as any,   // you can change this manually before saving
    })
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 420 } } }}
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <Stack gap={2} p={3}>
          <Typography variant="h6">
            {initial?.name ? 'Edit Item' : 'Add Item'}
          </Typography>

          {/* 🔍 Search existing item by name/brand and auto-fill form */}
          <Autocomplete
            options={items}
            getOptionLabel={(option: any) =>
              option?.name
                ? `${option.name}${option.brand ? ` (${option.brand})` : ''}`
                : ''
            }
            onChange={(_, value) => applyFromExisting(value)}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Search existing (name/brand)"
                placeholder="Type initials to select item"
              />
            )}
            size="small"
          />
          <Typography variant="caption" color="text.secondary">
            Select an existing item to auto-fill. You can still edit any field.
          </Typography>

          <TextField
            label="Name"
            {...register('name')}
            InputLabelProps={{ shrink: true }}
            error={!!errors.name}
            helperText={errors.name?.message}
          />

          <TextField
            label="Brand"
            {...register('brand')}
            InputLabelProps={{ shrink: true }} 
          />

          {/* ✅ Native calendar picker, value = "YYYY-MM-DD" */}
          <TextField
            label="Expiry"
            type="date"
            {...register('expiry_date')}
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: today }} // block past dates (optional)
            error={!!errors.expiry_date}
            helperText={errors.expiry_date?.message || 'Format: YYYY-MM-DD'}
          />

          <TextField
            label="MRP"
            type="number"
            inputProps={{ step: 'any' }}
            {...register('mrp', { valueAsNumber: true })}
            InputLabelProps={{ shrink: true }}
            error={!!errors.mrp}
            helperText={errors.mrp?.message}
          />

          <TextField
            label="Stock"
            type="number"
            {...register('stock', { valueAsNumber: true })}
            InputLabelProps={{ shrink: true }}
            error={!!errors.stock}
            helperText={errors.stock?.message}
          />

          <Stack direction="row" gap={1} justifyContent="flex-end">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="contained" disabled={isSubmitting}>
              Save
            </Button>
          </Stack>
        </Stack>
      </form>
    </Drawer>
  )
}
