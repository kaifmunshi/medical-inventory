// F:\medical-inventory\frontend\src\pages\Inventory\ItemForm.tsx
import {
  Drawer,
  Stack,
  TextField,
  Button,
  Typography,
  Autocomplete,
  CircularProgress,
} from '@mui/material'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { itemSchema } from '../../lib/validators'
import { z } from 'zod'
import React from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { listItemsPage } from '../../services/inventory'

export type ItemFormValues = z.infer<typeof itemSchema>

type ItemFormProps = {
  open: boolean
  initial?: Partial<ItemFormValues> | null
  onClose: () => void
  onSubmit: (values: ItemFormValues) => void
  items?: any[] // kept for backward compatibility (not used for pagination anymore)
}

function buildUniqueKey(it: any) {
  const name = String(it?.name ?? '').trim().toLowerCase()
  const brand = String(it?.brand ?? '').trim().toLowerCase()
  return `${name}__${brand}`
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
    formState: { errors, isSubmitting },
  } = useForm<ItemFormValues>({
    resolver: zodResolver(itemSchema),
    defaultValues: {
      name: initial?.name ?? '',
      brand: (initial?.brand as any) ?? '',
      expiry_date: (initial?.expiry_date as any) ?? '',
      mrp: Number((initial as any)?.mrp ?? 0),
      stock: Number((initial as any)?.stock ?? 0),

      // ✅ NEW
      rack_number: Number((initial as any)?.rack_number ?? 0),
    },
  })

  // 1️⃣ When editing an item: fill form from `initial`
  React.useEffect(() => {
    if (!initial) return
    reset({
      name: initial.name ?? '',
      brand: (initial.brand as any) ?? '',
      expiry_date: (initial.expiry_date as any) ?? '',
      mrp: Number((initial as any).mrp ?? 0),
      stock: Number((initial as any).stock ?? 0),

      // ✅ NEW
      rack_number: Number((initial as any).rack_number ?? 0),
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

        // ✅ NEW: default 0 for new items
        rack_number: 0 as any,
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
      stock: '' as any,

      // ✅ NEW
      rack_number: Number(it.rack_number ?? 0),
    })
  }

  // -----------------------------
  // ✅ Infinite scroll autocomplete
  // -----------------------------
  const LIMIT = 50
  const [searchText, setSearchText] = React.useState('')
  const [debouncedSearch, setDebouncedSearch] = React.useState('')

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchText.trim()), 250)
    return () => clearTimeout(t)
  }, [searchText])

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery({
    queryKey: ['inventory-autocomplete', debouncedSearch],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => listItemsPage(debouncedSearch, LIMIT, pageParam),
    getNextPageParam: (lastPage) => lastPage?.next_offset ?? undefined,
    enabled: open, // only fetch when drawer open
  })

  // Flatten pages -> options
  const options = React.useMemo(() => {
    const all = data?.pages.flatMap((p) => p.items) ?? []

    // ✅ de-duplicate by (name + brand) so expiry-based duplicates don't appear
    // Pick the "best" representative per group:
    // - higher stock wins
    // - if tie, higher id wins (newer row)
    const map = new Map<string, any>()

    for (const it of all) {
      const key = buildUniqueKey(it)
      if (!key || key === '__') continue

      const prev = map.get(key)
      if (!prev) {
        map.set(key, it)
        continue
      }

      const s1 = Number(prev?.stock) || 0
      const s2 = Number(it?.stock) || 0
      if (s2 > s1) {
        map.set(key, it)
        continue
      }

      const id1 = Number(prev?.id) || 0
      const id2 = Number(it?.id) || 0
      if (s2 === s1 && id2 > id1) {
        map.set(key, it)
      }
    }

    const uniq = Array.from(map.values())

    // fallback to passed items if nothing loaded yet
    if (uniq.length === 0 && Array.isArray(items) && items.length > 0) {
      // also de-dup fallback items
      const map2 = new Map<string, any>()
      for (const it of items) {
        const key = buildUniqueKey(it)
        if (!key || key === '__') continue
        if (!map2.has(key)) map2.set(key, it)
      }
      return Array.from(map2.values())
    }

    return uniq
  }, [data, items])

  // Load more on dropdown scroll bottom
  const handleListboxScroll = (event: React.UIEvent<HTMLUListElement>) => {
    const listboxNode = event.currentTarget
    const nearBottom =
      listboxNode.scrollTop + listboxNode.clientHeight >=
      listboxNode.scrollHeight - 40

    if (nearBottom && hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
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

          {/* ✅ Infinite scroll + server-side search */}
          <Autocomplete
            options={options}
            loading={isLoading || isFetchingNextPage}
            onChange={(_, value) => applyFromExisting(value)}
            onInputChange={(_, value) => setSearchText(value)}
            ListboxProps={{
              onScroll: handleListboxScroll,
              style: { maxHeight: 280, overflow: 'auto' },
            }}
            disablePortal
            isOptionEqualToValue={(opt: any, val: any) =>
              buildUniqueKey(opt) === buildUniqueKey(val)
            }
            getOptionLabel={(option: any) =>
              option?.name
                ? `${option.name}${option.brand ? ` (${option.brand})` : ''}`
                : ''
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Search existing (name/brand)"
                placeholder="Type to search"
                size="small"
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {isLoading || isFetchingNextPage ? (
                        <CircularProgress size={18} />
                      ) : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />

          <Typography variant="caption" color="text.secondary">
            Scroll the dropdown to load more items. Type to search.
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

          <TextField
            label="Expiry"
            type="date"
            {...register('expiry_date')}
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: today }}
            error={!!errors.expiry_date}
            helperText={errors.expiry_date?.message || 'Format: DD-MM-YYYY'}
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

          {/* ✅ NEW: Rack Number */}
          <TextField
            label="Rack Number"
            type="number"
            inputProps={{ step: 1, min: 0 }}
            {...register('rack_number', { valueAsNumber: true })}
            InputLabelProps={{ shrink: true }}
            error={!!(errors as any).rack_number}
            helperText={(errors as any).rack_number?.message || 'Default: 0'}
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
