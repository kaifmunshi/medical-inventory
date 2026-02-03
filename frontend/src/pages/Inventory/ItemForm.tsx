// F:\medical-inventory\frontend\src\pages\Inventory\ItemForm.tsx
import {
  Drawer,
  Stack,
  TextField,
  Button,
  Typography,
  Autocomplete,
  CircularProgress,
  Box,
  Chip,
  Divider,
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

function norm(s: any) {
  return String(s ?? '').trim().toLowerCase()
}
function toIsoDateOnly(exp?: string | null) {
  if (!exp) return ''
  const s = String(exp)
  return s.length > 10 ? s.slice(0, 10) : s
}
function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const iso = toIsoDateOnly(exp)
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}`
}
function formatMoney(n: any) {
  const x = Number(n)
  if (!Number.isFinite(x)) return String(n ?? '')
  return String(x)
}

export default function ItemForm({
  open,
  initial,
  onClose,
  onSubmit,
  items = [],
}: ItemFormProps) {
  // YYYY-MM-DD for today's date (used to block past expiries for brand-new entries)
  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), [])

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ItemFormValues>({
    resolver: zodResolver(itemSchema),
    defaultValues: {
      name: initial?.name ?? '',
      brand: (initial?.brand as any) ?? '',
      expiry_date: (initial?.expiry_date as any) ?? '',
      mrp: Number((initial as any)?.mrp ?? 0),
      stock: Number((initial as any)?.stock ?? 0),
      rack_number: Number((initial as any)?.rack_number ?? 0),
    },
  })

  const isEditMode = Boolean(initial?.name)

  // Track selection from picker (Add mode only)
  const [pickedExisting, setPickedExisting] = React.useState<any | null>(null)

  // 1️⃣ When editing: fill from initial
  React.useEffect(() => {
    if (!initial) return
    setPickedExisting(null)
    reset({
      name: initial.name ?? '',
      brand: (initial.brand as any) ?? '',
      expiry_date: (initial.expiry_date as any) ?? '',
      mrp: Number((initial as any).mrp ?? 0),
      stock: Number((initial as any).stock ?? 0),
      rack_number: Number((initial as any).rack_number ?? 0),
    })
  }, [initial, reset])

  // 2️⃣ When opening "Add Item": clear every time
  React.useEffect(() => {
    if (open && !initial) {
      setPickedExisting(null)
      reset({
        name: '',
        brand: '',
        expiry_date: '',
        mrp: '' as any,
        stock: '' as any,
        rack_number: 0 as any,
      })
    }
  }, [open, initial, reset])

  // Prefill from existing batch
  function applyFromExisting(it: any) {
    if (!it) {
      setPickedExisting(null)
      return
    }
    setPickedExisting(it)
    reset({
      name: it.name ?? '',
      brand: it.brand ?? '',
      expiry_date: toIsoDateOnly(it.expiry_date) as any,
      mrp: Number(it.mrp ?? 0),
      stock: '' as any, // user enters quantity
      rack_number: Number(it.rack_number ?? 0),
    })
  }

  // Watch fields to decide behavior
  const wName = watch('name')
  const wBrand = watch('brand')
  const wExpiry = watch('expiry_date')
  const wMrp = watch('mrp')

  // ✅ Decide if this is "merge into existing" or "new batch"
  const willMergeIntoPicked = React.useMemo(() => {
    if (!pickedExisting || isEditMode) return false
    const sameName = norm(wName) === norm(pickedExisting?.name)
    const sameBrand = norm(wBrand) === norm(pickedExisting?.brand)
    const sameExpiry = toIsoDateOnly(wExpiry) === toIsoDateOnly(pickedExisting?.expiry_date)
    const sameMrp = Number(wMrp) === Number(pickedExisting?.mrp)
    return sameName && sameBrand && sameExpiry && sameMrp
  }, [pickedExisting, isEditMode, wName, wBrand, wExpiry, wMrp])

  // ✅ Lock only Name/Brand when batch is picked (so user never has to retype),
  // but allow changing Expiry/MRP to create a new batch.
  const lockNameBrand = Boolean(pickedExisting) && !isEditMode

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
    enabled: open && !isEditMode,
  })

  const options = React.useMemo(() => {
    const all = data?.pages.flatMap((p) => p.items) ?? []

    // de-dupe by id only
    const seen = new Set<number>()
    const out: any[] = []
    for (const it of all) {
      const id = Number(it?.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(it)
    }

    // fallback if nothing loaded yet
    if (out.length === 0 && Array.isArray(items) && items.length > 0) {
      const seen2 = new Set<number>()
      const out2: any[] = []
      for (const it of items) {
        const id = Number(it?.id)
        if (!id || seen2.has(id)) continue
        seen2.add(id)
        out2.push(it)
      }
      return out2
    }

    out.sort((a, b) => {
      const an = norm(a?.name)
      const bn = norm(b?.name)
      if (an !== bn) return an.localeCompare(bn)
      const ab = norm(a?.brand)
      const bb = norm(b?.brand)
      if (ab !== bb) return ab.localeCompare(bb)

      const da = toIsoDateOnly(a?.expiry_date)
      const db = toIsoDateOnly(b?.expiry_date)
      if (!da && !db) return 0
      if (!da) return 1
      if (!db) return -1
      return da.localeCompare(db)
    })

    return out
  }, [data, items])

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
            {isEditMode ? 'Edit Item' : 'Add Item'}
          </Typography>

          {/* ✅ Smart picker (only in Add mode) */}
          {!isEditMode && (
            <>
              <Autocomplete
                options={options}
                loading={isLoading || isFetchingNextPage}
                value={pickedExisting}
                onChange={(_, value) => applyFromExisting(value)}
                onInputChange={(_, value) => setSearchText(value)}
                ListboxProps={{
                  onScroll: handleListboxScroll,
                  style: { maxHeight: 320, overflow: 'auto' },
                }}
                disablePortal
                isOptionEqualToValue={(opt: any, val: any) => Number(opt?.id) === Number(val?.id)}
                groupBy={(option: any) => {
                  const n = option?.name ? String(option.name) : ''
                  const b = option?.brand ? String(option.brand) : ''
                  return `${n}${b ? ` • ${b}` : ''}`
                }}
                getOptionLabel={(option: any) =>
                  option?.name
                    ? `${option.name}${option.brand ? ` (${option.brand})` : ''}`
                    : ''
                }
                renderOption={(props, option: any) => {
                  const expiry = formatExpiry(option?.expiry_date)
                  const mrp = formatMoney(option?.mrp)
                  const stock = Number(option?.stock ?? 0) || 0
                  const rack = option?.rack_number ?? 0

                  return (
                    <li {...props} key={option?.id}>
                      <Box sx={{ width: '100%' }}>
                        <Stack direction="row" justifyContent="space-between" gap={1}>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            Exp: {expiry}
                          </Typography>

                          <Stack direction="row" gap={1} alignItems="center">
                            <Chip size="small" label={`MRP: ${mrp}`} sx={{ height: 20 }} />
                            <Chip size="small" label={`Stock: ${stock}`} sx={{ height: 20 }} />
                          </Stack>
                        </Stack>

                        <Typography variant="caption" color="text.secondary">
                          Rack: {rack} • ID: {option?.id}
                        </Typography>
                      </Box>
                    </li>
                  )
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Find existing batch (recommended)"
                    placeholder="Type item name / brand"
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
                Tip: Select a batch to add stock into it. If you change expiry/MRP, it becomes a new batch.
              </Typography>

              {pickedExisting && (
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 2,
                    p: 1.25,
                    bgcolor: 'background.paper',
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {willMergeIntoPicked ? 'Existing batch selected' : 'New batch (from selected)'}
                  </Typography>

                  <Typography variant="caption" color="text.secondary">
                    {willMergeIntoPicked
                      ? 'Saving will add stock to this batch (same name + brand + expiry + MRP).'
                      : 'You changed expiry/MRP. Saving will create a NEW batch with same name/brand.'}
                  </Typography>

                  <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
                    <Button
                      size="small"
                      onClick={() => {
                        // Clear selection but keep whatever user already typed in the form
                        setPickedExisting(null)
                      }}
                    >
                      Clear selection
                    </Button>
                  </Stack>
                </Box>
              )}

              <Divider />
            </>
          )}

          <TextField
            label="Name"
            {...register('name')}
            InputLabelProps={{ shrink: true }}
            error={!!errors.name}
            helperText={errors.name?.message}
            disabled={lockNameBrand}
          />

          <TextField
            label="Brand"
            {...register('brand')}
            InputLabelProps={{ shrink: true }}
            disabled={lockNameBrand}
          />

          <TextField
            label="Expiry"
            type="date"
            {...register('expiry_date')}
            InputLabelProps={{ shrink: true }}
            // For totally new entries, block past; for pickedExisting we allow editing freely
            inputProps={{
              min: !isEditMode && !pickedExisting ? today : undefined,
            }}
            error={!!errors.expiry_date}
            helperText={errors.expiry_date?.message || 'Select expiry date'}
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
            label="Rack Number"
            type="number"
            inputProps={{ step: 1, min: 0 }}
            {...register('rack_number', { valueAsNumber: true })}
            InputLabelProps={{ shrink: true }}
            error={!!(errors as any).rack_number}
            helperText={(errors as any).rack_number?.message || 'Default: 0'}
          />

          <TextField
            label={
              pickedExisting && !isEditMode && willMergeIntoPicked ? 'Add Stock (+)' : 'Stock'
            }
            type="number"
            {...register('stock', { valueAsNumber: true })}
            InputLabelProps={{ shrink: true }}
            error={!!errors.stock}
            helperText={
              errors.stock?.message ||
              (pickedExisting && !isEditMode
                ? willMergeIntoPicked
                  ? 'Enter quantity to add into selected batch'
                  : 'Opening stock for NEW batch'
                : '')
            }
          />

          <Stack direction="row" gap={1} justifyContent="flex-end">
            <Button
              onClick={() => {
                setPickedExisting(null)
                onClose()
              }}
            >
              Cancel
            </Button>

            <Button type="submit" variant="contained" disabled={isSubmitting}>
              Save
            </Button>
          </Stack>
        </Stack>
      </form>
    </Drawer>
  )
}
