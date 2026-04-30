// frontend/src/pages/Inventory/index.tsx

import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
  Tooltip,
  Chip,
  useMediaQuery,
} from '@mui/material'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  listItemsPage,
  createItem,
  updateItem,
  adjustStock,
} from '../../services/inventory'

import Loading from '../../components/ui/Loading'
import ItemForm from './ItemForm'
import type { ItemFormValues } from './ItemForm'
import EditIcon from '@mui/icons-material/Edit'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import CloseIcon from '@mui/icons-material/Close'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'

import AdjustStockDialog from '../../components/ui/AdjustStockDialog'
import { useToast } from '../../components/ui/Toaster'
import {
  createBrand,
  createCategory,
  createProduct,
  fetchBrands,
  fetchCategories,
  fetchProducts,
  updateProduct,
  type ProductPayload,
} from '../../services/products'

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s // "YYYY-MM-DD"
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}` // "DD-MM-YYYY"
}

function toIsoDateOnly(exp?: string | null) {
  if (!exp) return ''
  const s = String(exp)
  return s.length > 10 ? s.slice(0, 10) : s
}

function buildGroupKey(it: any) {
  const name = String(it?.name ?? '').trim().toLowerCase()
  const brand = String(it?.brand ?? '').trim().toLowerCase()
  return `${name}__${brand}`
}

function findExactProduct(products: any[], name?: string, brand?: string) {
  const nameKey = String(name || '').trim().toLowerCase()
  const brandKey = String(brand || '').trim().toLowerCase()
  return products.find((product) => (
    String(product?.name || '').trim().toLowerCase() === nameKey
    && String(product?.brand || '').trim().toLowerCase() === brandKey
  )) || null
}

export default function Inventory() {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isSm = useMediaQuery('(max-width:900px)')

  const [q, setQ] = useState(searchParams.get('q') || '')
  const [debouncedQ, setDebouncedQ] = useState('') // ✅ debounce search input
  const [rackQ, setRackQ] = useState(searchParams.get('rack') || '')
  const [debouncedRackQ, setDebouncedRackQ] = useState('')
  const [brandFilter, setBrandFilter] = useState(searchParams.get('brand') || '')
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '')

  const [openForm, setOpenForm] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [productOpen, setProductOpen] = useState(false)
  const [productId, setProductId] = useState<number | null>(null)
  const [productBrandOpen, setProductBrandOpen] = useState(false)
  const [productCategoryOpen, setProductCategoryOpen] = useState(false)
  const [productBrandName, setProductBrandName] = useState('')
  const [productCategoryName, setProductCategoryName] = useState('')
  const [productForm, setProductForm] = useState<ProductPayload>({
    name: '',
    brand: '',
    category_id: undefined,
    default_rack_number: 0,
    printed_price: 0,
    loose_sale_enabled: false,
    parent_unit_name: '',
    child_unit_name: '',
    default_conversion_qty: undefined,
  })
  const [adjustId, setAdjustId] = useState<number | null>(null)
  const [adjustName, setAdjustName] = useState<string>('')
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  // ✅ Debounce typing to avoid calling API on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 600)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    const t = setTimeout(() => setDebouncedRackQ(rackQ.trim()), 600)
    return () => clearTimeout(t)
  }, [rackQ])
  useEffect(() => {
    setQ(searchParams.get('q') || '')
    setRackQ(searchParams.get('rack') || '')
    setBrandFilter(searchParams.get('brand') || '')
    setCategoryFilter(searchParams.get('category') || '')
  }, [searchParams])

  const qc = useQueryClient()
  const LIMIT = 50

  // ✅ Infinite inventory query (loads 50 at a time)
  const {
    data,
    isLoading,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['inventory-items', debouncedQ, debouncedRackQ, brandFilter, categoryFilter],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      try {
        const rackFilter =
          debouncedRackQ !== '' && /^\d+$/.test(debouncedRackQ)
            ? Number(debouncedRackQ)
            : undefined
        return await listItemsPage(debouncedQ, LIMIT, pageParam, rackFilter, {
          brand: brandFilter || undefined,
          category_id: categoryFilter ? Number(categoryFilter) : undefined,
        })
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || 'Failed to load inventory'
        toast.push(String(msg), 'error')
        throw err
      }
    },
    getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
  })

  const rows = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  const hasFilters = q.trim() !== '' || rackQ.trim() !== '' || brandFilter !== '' || categoryFilter !== ''

  const brandsQ = useQuery({ queryKey: ['inventory-brands'], queryFn: () => fetchBrands({ active_only: true }) })
  const categoriesQ = useQuery({ queryKey: ['inventory-categories'], queryFn: () => fetchCategories({ active_only: true }) })
  const productsQ = useQuery({
    queryKey: ['inventory-products-master'],
    queryFn: () => fetchProducts({ active_only: true, limit: 2000 }),
  })
  const categoryNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const c of categoriesQ.data || []) map.set(Number(c.id), c.name)
    return map
  }, [categoriesQ.data])

  useEffect(() => {
    const el = loadMoreRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        if (!hasNextPage || isFetchingNextPage) return
        void fetchNextPage()
      },
      { root: null, rootMargin: '0px 0px 120px 0px', threshold: 0 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  // ✅ Group rows by (name + brand) ALWAYS (includes stock=0 batches)
  const groups = useMemo(() => {
    const map = new Map<string, any[]>()

    for (const it of rows) {
      const key = buildGroupKey(it)
      const arr = map.get(key) ?? []
      arr.push(it)
      map.set(key, arr)
    }

    const list = Array.from(map.entries()).map(([key, items]) => {
      const sorted = [...items].sort((a, b) => {
        const da = toIsoDateOnly(a?.expiry_date)
        const db = toIsoDateOnly(b?.expiry_date)
        if (!da && !db) return 0
        if (!da) return 1
        if (!db) return -1
        return da.localeCompare(db)
      })

      const totalStock = sorted.reduce((sum, x) => sum + (Number(x.stock) || 0), 0)
      const inStock = sorted.filter((x) => Number(x?.stock ?? 0) > 0)
      // UI rule:
      // - if any in-stock batch exists, hide zero-stock batches in table rows
      // - if all batches are zero, show exactly one batch row (earliest expiry)
      const displayItems = inStock.length > 0 ? inStock : sorted.slice(0, 1)

      const racks = new Set(displayItems.map((x) => String(x.rack_number ?? 0)))
      const rackLabel = racks.size === 1 ? (displayItems[0]?.rack_number ?? 0) : '-'

      const earliestExpiryIso = toIsoDateOnly(displayItems[0]?.expiry_date)
      const expiryLabel = earliestExpiryIso ? formatExpiry(earliestExpiryIso) : '-'

      // ✅ MRP label + show "batches" ONLY if MRP varies
      const mrpNums = displayItems.map((x) => Number(x.mrp)).filter((n) => Number.isFinite(n))

      let mrpLabel: string | number = '-'
      let hasMrpVariance = false

      if (mrpNums.length > 0) {
        const min = Math.min(...mrpNums)
        const max = Math.max(...mrpNums)
        hasMrpVariance = min !== max
        mrpLabel = min === max ? min : `${min}–${max}`
      }

      return {
        key,
        name: sorted[0]?.name,
        brand: sorted[0]?.brand,
        category_id: sorted[0]?.category_id,
        categoryName: sorted[0]?.category_id ? categoryNameById.get(Number(sorted[0].category_id)) || '-' : '-',
        rackLabel,
        expiryLabel,
        mrpLabel,
        hasMrpVariance, // ✅ NEW
        totalStock,
        count: displayItems.length, // visible batch rows only
        totalBatchCount: sorted.length, // all batches
        items: sorted, // all batches (ledger)
        displayItems, // visible in table
      }
    })

    list.sort((a, b) => {
      const an = String(a.name ?? '').toLowerCase()
      const bn = String(b.name ?? '').toLowerCase()
      if (an !== bn) return an.localeCompare(bn)
      const ab = String(a.brand ?? '').toLowerCase()
      const bb = String(b.brand ?? '').toLowerCase()
      return ab.localeCompare(bb)
    })

    return list
  }, [rows, categoryNameById])

  const mCreate = useMutation({
    mutationFn: (payload: ItemFormValues) => createItem(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Saved', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Create failed'
      toast.push(String(msg), 'error')
    },
  })

  const mUpdate = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ItemFormValues }) => {
      const { stock: _ignoredStock, ...safePayload } = payload
      return updateItem(id, safePayload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Item updated', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Update failed'
      toast.push(String(msg), 'error')
    },
  })

  const mAdjust = useMutation({
    mutationFn: ({ id, delta }: { id: number; delta: number }) => adjustStock(id, delta),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Stock adjusted', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Adjust stock failed'
      toast.push(String(msg), 'error')
    },
  })

  const mSaveProduct = useMutation({
    mutationFn: async () => {
      const payload: ProductPayload = {
        ...productForm,
        name: productForm.name.trim(),
        brand: productForm.brand?.trim() || undefined,
        category_id: productForm.category_id || undefined,
        default_rack_number: Number(productForm.default_rack_number || 0),
        printed_price: Number(productForm.printed_price || 0),
        parent_unit_name: productForm.loose_sale_enabled ? productForm.parent_unit_name?.trim() || 'Pack' : undefined,
        child_unit_name: productForm.loose_sale_enabled ? productForm.child_unit_name?.trim() || 'Unit' : undefined,
        default_conversion_qty: productForm.loose_sale_enabled ? Number(productForm.default_conversion_qty || 1) : undefined,
      }
      let targetId = productId
      if (!targetId) {
        const knownMatch = findExactProduct(productsQ.data || [], payload.name, payload.brand)
        const freshMatch = knownMatch || findExactProduct(
          await fetchProducts({ q: payload.name, active_only: false, limit: 1000 }),
          payload.name,
          payload.brand,
        )
        targetId = freshMatch?.id ? Number(freshMatch.id) : null
      }
      return targetId ? updateProduct(targetId, payload) : createProduct(payload)
    },
    onSuccess: (savedProduct) => {
      setProductId(Number(savedProduct.id))
      setProductForm({
        name: savedProduct.name,
        brand: savedProduct.brand || '',
        category_id: savedProduct.category_id || undefined,
        default_rack_number: savedProduct.default_rack_number ?? 0,
        printed_price: savedProduct.printed_price ?? 0,
        loose_sale_enabled: Boolean(savedProduct.loose_sale_enabled),
        parent_unit_name: savedProduct.parent_unit_name || '',
        child_unit_name: savedProduct.child_unit_name || '',
        default_conversion_qty: savedProduct.default_conversion_qty || undefined,
      })
      setProductOpen(false)
      qc.invalidateQueries({ queryKey: ['inventory-products-master'] })
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['lots'] })
      toast.push('Product master saved', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Product save failed'
      toast.push(String(msg), 'error')
    },
  })

  const mCreateProductBrand = useMutation({
    mutationFn: createBrand,
    onSuccess: (brand) => {
      setProductForm((prev) => ({ ...prev, brand: brand.name }))
      setProductBrandName('')
      setProductBrandOpen(false)
      qc.invalidateQueries({ queryKey: ['inventory-brands'] })
      qc.invalidateQueries({ queryKey: ['brand-master'] })
      toast.push('Brand added', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to add brand'
      toast.push(String(msg), 'error')
    },
  })

  const mCreateProductCategory = useMutation({
    mutationFn: createCategory,
    onSuccess: (category) => {
      setProductForm((prev) => ({ ...prev, category_id: Number(category.id) }))
      setProductCategoryName('')
      setProductCategoryOpen(false)
      qc.invalidateQueries({ queryKey: ['inventory-categories'] })
      qc.invalidateQueries({ queryKey: ['product-categories-master'] })
      toast.push('Category added', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to add category'
      toast.push(String(msg), 'error')
    },
  })

  function setProductLooseSaleEnabled(next: boolean) {
    if (!next && productForm.loose_sale_enabled) {
      const ok = window.confirm(
        'Disable loose stock for this product? New parent units cannot be opened after this, but existing loose stock, bills, returns, and ledgers will remain usable.'
      )
      if (!ok) return
    }
    setProductForm((prev) => ({ ...prev, loose_sale_enabled: next }))
  }

  function handleAdd() {
    setEditing(null)
    setOpenForm(true)
  }
  function handleEdit(row: any) {
    setEditing(row)
    setOpenForm(true)
  }
  function handleAdjust(row: any) {
    setAdjustId(row.id)
    setAdjustName(row.name)
  }

  async function openRelatedProduct(group: any) {
    const name = String(group?.name || '')
    const brand = String(group?.brand || '')
    let product = null
    try {
      product = findExactProduct(await fetchProducts({ q: name, active_only: false, limit: 1000 }), name, brand)
    } catch {
      product = findExactProduct(productsQ.data || [], name, brand)
    }
    setProductId(product?.id ? Number(product.id) : null)
    setProductForm({
      name,
      brand,
      category_id: product?.category_id || group?.category_id || undefined,
      default_rack_number: product?.default_rack_number ?? Number(group?.rackLabel || group?.displayItems?.[0]?.rack_number || 0),
      printed_price: product?.printed_price ?? Number(group?.displayItems?.[0]?.mrp || 0),
      loose_sale_enabled: Boolean(product?.loose_sale_enabled),
      parent_unit_name: product?.parent_unit_name || '',
      child_unit_name: product?.child_unit_name || '',
      default_conversion_qty: product?.default_conversion_qty || undefined,
    })
    setProductOpen(true)
  }

  function openStockCardForGroup(group: any) {
    const params = new URLSearchParams()
    params.set('name', String(group?.name || ''))
    if (group?.brand) params.set('brand', String(group.brand))
    params.set('tab', 'summary')
    navigate(`/inventory/stock-card?${params.toString()}`)
  }

  function openStockCardForBatch(group: any, item: any) {
    const params = new URLSearchParams()
    params.set('name', String(group?.name || ''))
    if (group?.brand) params.set('brand', String(group.brand))
    if (item?.id) params.set('batchId', String(item.id))
    params.set('tab', 'batch')
    navigate(`/inventory/stock-card?${params.toString()}`)
  }

  return (
    <Stack gap={2} sx={{ minWidth: 0, width: '100%' }}>
      <Typography variant="h5">Inventory</Typography>

      <Paper
        sx={{
          p: { xs: 1.5, sm: 2 },
          borderRadius: 3,
          border: '1px solid rgba(20,92,59,0.14)',
          background: 'linear-gradient(180deg, #ffffff 0%, #f8fcfa 100%)',
        }}
      >
        <Stack direction={{ xs: 'column', md: 'row' }} gap={1.25} alignItems={{ md: 'center' }}>
          <TextField
            placeholder="Search by medicine name or brand"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
            size="small"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRoundedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                </InputAdornment>
              ),
              endAdornment: q ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setQ('')} edge="end">
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: 2.5,
                background: '#fff',
                minHeight: 46,
              },
            }}
          />

          <TextField
            placeholder="Rack no."
            value={rackQ}
            onChange={(e) => setRackQ(e.target.value.replace(/[^\d]/g, ''))}
            type="text"
            size="small"
            inputProps={{ inputMode: 'numeric', pattern: '[0-9]*' }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <GridViewRoundedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                </InputAdornment>
              ),
              endAdornment: rackQ ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setRackQ('')} edge="end">
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            }}
            sx={{
              width: { xs: '100%', md: 180 },
              '& .MuiOutlinedInput-root': {
                borderRadius: 2.5,
                background: '#fff',
                minHeight: 46,
              },
            }}
          />

          <TextField
            select
            label="Brand"
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
            size="small"
            sx={{ width: { xs: '100%', md: 190 }, '& .MuiOutlinedInput-root': { borderRadius: 2.5, background: '#fff', minHeight: 46 } }}
          >
            <MenuItem value="">All Brands</MenuItem>
            {(brandsQ.data || []).map((brand) => (
              <MenuItem key={brand.id} value={brand.name}>
                {brand.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            size="small"
            sx={{ width: { xs: '100%', md: 210 }, '& .MuiOutlinedInput-root': { borderRadius: 2.5, background: '#fff', minHeight: 46 } }}
          >
            <MenuItem value="">All Categories</MenuItem>
            {(categoriesQ.data || []).map((category) => (
              <MenuItem key={category.id} value={String(category.id)}>
                {category.name}
              </MenuItem>
            ))}
          </TextField>

          <Button variant="contained" onClick={handleAdd} sx={{ minWidth: { md: 132 }, height: 46 }}>
            Add Item
          </Button>
        </Stack>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          gap={0.75}
          justifyContent="space-between"
          alignItems={{ sm: 'center' }}
          sx={{ mt: 1.25 }}
        >
          <Typography variant="caption" color="text.secondary">
            Inventory is grouped by item (name + brand). Separate entries stay as batch rows; Stock Card shows every movement.
          </Typography>
          {hasFilters && (
            <Button
              size="small"
              onClick={() => {
                setQ('')
                setRackQ('')
                setBrandFilter('')
                setCategoryFilter('')
              }}
              sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}
            >
              Clear filters
            </Button>
          )}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2, minWidth: 0, width: '100%', overflow: 'hidden' }}>
        {isLoading ? (
          <Loading />
        ) : (
          <>
            <Box
              component="div"
              sx={{
                width: '100%',
                maxWidth: '100%',
                minWidth: 0,
                overflowX: 'auto',
                WebkitOverflowScrolling: 'touch',
                '& .inventory-grid': {
                  borderCollapse: 'collapse',
                  width: '100%',
                  minWidth: 1180,
                  tableLayout: 'fixed',
                },
                '& .inventory-grid th:nth-of-type(1), & .inventory-grid td:nth-of-type(1)': { width: 260 },
                '& .inventory-grid th:nth-of-type(2), & .inventory-grid td:nth-of-type(2)': { width: 76 },
                '& .inventory-grid th:nth-of-type(3), & .inventory-grid td:nth-of-type(3)': { width: 150 },
                '& .inventory-grid th:nth-of-type(4), & .inventory-grid td:nth-of-type(4)': { width: 140 },
                '& .inventory-grid th:nth-of-type(5), & .inventory-grid td:nth-of-type(5)': { width: 130 },
                '& .inventory-grid th:nth-of-type(6), & .inventory-grid td:nth-of-type(6)': { width: 92 },
                '& .inventory-grid th:nth-of-type(7), & .inventory-grid td:nth-of-type(7)': { width: 72 },
                '& .inventory-grid th:nth-of-type(8), & .inventory-grid td:nth-of-type(8)': { width: 260 },
                '& .inventory-grid thead th': {
                  borderBottom: '1px solid rgba(0,0,0,0.14)',
                  background: 'rgba(255,255,255,0.98)',
                },
                '& .inventory-grid th, & .inventory-grid td': {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
                '& .inventory-grid th:last-of-type, & .inventory-grid td:last-of-type': {
                  overflow: 'visible',
                },
                '& .inventory-grid tbody tr > td': {
                  background: '#fff',
                  borderBottom: '1px solid rgba(0,0,0,0.08)',
                },
                '& .inventory-grid tbody tr.parent-row > td': {
                  background: 'rgba(20,92,59,0.06)',
                  borderTop: '2px solid rgba(20,92,59,0.35)',
                  borderBottom: '1px solid rgba(20,92,59,0.20)',
                },
                '& .inventory-grid tbody tr.batch-row > td': {
                  background: 'rgba(255,255,255,0.98)',
                  borderBottom: '1px dashed rgba(20,92,59,0.22)',
                },
                '& .inventory-grid tbody tr.batch-row.out-row > td': {
                  background: 'rgba(244,67,54,0.08)',
                  borderBottom: '1px dashed rgba(211,47,47,0.32)',
                },
              }}
            >
              <table className="table inventory-grid">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Rack</th>
                    <th>Brand</th>
                    <th>Category</th>
                    <th>Earliest Expiry</th>
                    <th>MRP</th>
                    <th>Stock</th>
                    <th style={{ width: 260 }}>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {groups.flatMap((g: any) => {
                    const isOut = Number(g.totalStock || 0) <= 0

                    const parentRow = (
                      <tr
                        key={g.key}
                        className="parent-row"
                        onDoubleClick={() => openStockCardForGroup(g)}
                        style={{
                          background: isOut ? 'rgba(244,67,54,0.10)' : undefined,
                          opacity: 1,
                          cursor: 'pointer',
                        }}
                      >
                        <td style={{ padding: isSm ? '10px 8px' : undefined }}>
                          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                            <span style={{ fontWeight: 700 }}>{g.name}</span>

                            {isOut && (
                              <Chip
                                size="small"
                                label="Out of stock"
                                variant="outlined"
                                sx={{ fontWeight: 800, borderRadius: 999 }}
                              />
                            )}

                            {Number(g.totalBatchCount || 0) > 1 && (
                              <Chip
                                size="small"
                                label={`${g.totalBatchCount} separate entries`}
                                variant="outlined"
                                sx={{ fontWeight: 800, borderRadius: 999 }}
                              />
                            )}

                            {/* ✅ ONLY show this chip when MRP differs across batches */}
                            {g.hasMrpVariance && (
                              <Chip
                                size="small"
                                label={`${g.count} MRPs`}
                                variant="outlined"
                                sx={{ fontWeight: 800, borderRadius: 999 }}
                              />
                            )}
                          </Stack>
                        </td>

                        <td>{g.rackLabel}</td>
                        <td>{g.brand || '-'}</td>
                        <td>{g.categoryName || '-'}</td>
                        <td>{g.expiryLabel}</td>
                        <td>{g.mrpLabel}</td>

                        <td>
                          <Chip
                            size="small"
                            label={String(g.totalStock)}
                            sx={{ fontWeight: 900, borderRadius: 999 }}
                          />
                        </td>

                        <td>
                          <Stack direction="row" gap={1}>
                            <Tooltip title="Manage Product">
                              <Button
                                size="small"
                                variant="outlined"
                                onClick={() => openRelatedProduct(g)}
                                sx={{ minWidth: 0 }}
                              >
                                Product
                              </Button>
                            </Tooltip>
                            <Tooltip title="Open Stock Card">
                              <Button size="small" variant="outlined" onClick={() => openStockCardForGroup(g)}>
                                Stock Card
                              </Button>
                            </Tooltip>

                            <Tooltip title="Edit (earliest visible batch)">
                              <IconButton size="small" onClick={() => handleEdit(g.displayItems[0])}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>

                            <Tooltip title="Adjust Stock (earliest visible batch)">
                              <IconButton size="small" onClick={() => handleAdjust(g.displayItems[0])}>
                                <AddCircleOutlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </td>
                      </tr>
                    )
                    const batchRows =
                      Number(g.displayItems?.length || 0) > 1
                        ? g.displayItems.map((it: any) => {
                            const batchOut = Number(it?.stock || 0) <= 0
                            return (
                              <tr
                                key={`${g.key}-batch-${it.id}`}
                                className={`batch-row${batchOut ? ' out-row' : ''}`}
                                onDoubleClick={() => openStockCardForBatch(g, it)}
                                style={{ cursor: 'pointer' }}
                              >
                                <td style={{ paddingLeft: isSm ? 8 : 24 }}>
                                  <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                                    <span style={{ fontWeight: 600 }}>
                                      Batch #{it.id}
                                    </span>
                                    {batchOut && (
                                      <Chip size="small" label="Out of stock" variant="outlined" sx={{ borderRadius: 999 }} />
                                    )}
                                  </Stack>
                                </td>
                                <td>{it.rack_number ?? 0}</td>
                                <td>{g.brand || '-'}</td>
                                <td>{g.categoryName || '-'}</td>
                                <td>{formatExpiry(it.expiry_date)}</td>
                                <td>{Number(it.mrp || 0)}</td>
                                <td>
                                  <Chip
                                    size="small"
                                    label={String(Number(it.stock || 0))}
                                    sx={{ fontWeight: 900, borderRadius: 999 }}
                                  />
                                </td>
                                <td>
                                  <Stack direction="row" gap={1}>
                                    <Tooltip title="Open Batch Stock Card">
                                      <Button size="small" variant="outlined" onClick={() => openStockCardForBatch(g, it)}>
                                        Stock Card
                                      </Button>
                                    </Tooltip>

                                    <Tooltip title="Edit this batch">
                                      <IconButton size="small" onClick={() => handleEdit(it)}>
                                        <EditIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>

                                    <Tooltip title="Adjust stock">
                                      <IconButton size="small" onClick={() => handleAdjust(it)}>
                                        <AddCircleOutlineIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>
                                  </Stack>
                                </td>
                              </tr>
                            )
                          })
                        : []

                    return [parentRow, ...batchRows]
                  })}
                </tbody>
              </table>
            </Box>

            {!isFetching && rows.length === 0 && (
              <Box sx={{ py: 3, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  No items found.
                </Typography>
              </Box>
            )}
            <Box ref={loadMoreRef} sx={{ height: 1 }} />
            {isFetchingNextPage && (
              <Typography variant="body2" color="text.secondary" sx={{ pt: 1, textAlign: 'center' }}>
                Loading more...
              </Typography>
            )}
          </>
        )}
      </Paper>

      <ItemForm
        open={openForm}
        initial={editing}
        items={rows}
        onClose={() => setOpenForm(false)}
        onSubmit={(values) => {
          if (editing?.id) mUpdate.mutate({ id: editing.id, payload: values })
          else mCreate.mutate(values)
          setOpenForm(false)
        }}
      />

      <Dialog open={productOpen} onClose={() => setProductOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{productId ? 'Manage Product' : 'Add Product Master'}</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ pt: 1 }}>
            <TextField
              label="Product Name"
              value={productForm.name}
              onChange={(e) => setProductForm((prev) => ({ ...prev, name: e.target.value }))}
              fullWidth
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
              <TextField
                select
                label="Brand"
                value={productForm.brand || ''}
                onChange={(e) => setProductForm((prev) => ({ ...prev, brand: e.target.value }))}
                fullWidth
              >
                <MenuItem value="">No Brand</MenuItem>
                {(brandsQ.data || []).map((brand) => (
                  <MenuItem key={brand.id} value={brand.name}>
                    {brand.name}
                  </MenuItem>
                ))}
              </TextField>
              <Button variant="outlined" onClick={() => setProductBrandOpen(true)} sx={{ whiteSpace: 'nowrap', height: 40 }}>
                New Brand
              </Button>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
              <TextField
                select
                label="Category"
                value={productForm.category_id ? String(productForm.category_id) : ''}
                onChange={(e) => setProductForm((prev) => ({ ...prev, category_id: e.target.value ? Number(e.target.value) : undefined }))}
                fullWidth
              >
                <MenuItem value="">No Category</MenuItem>
                {(categoriesQ.data || []).map((category) => (
                  <MenuItem key={category.id} value={String(category.id)}>
                    {category.name}
                  </MenuItem>
                ))}
              </TextField>
              <Button variant="outlined" onClick={() => setProductCategoryOpen(true)} sx={{ whiteSpace: 'nowrap', height: 40 }}>
                New Category
              </Button>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
              <TextField
                label="Default Rack"
                type="number"
                value={productForm.default_rack_number ?? 0}
                onChange={(e) => setProductForm((prev) => ({ ...prev, default_rack_number: Number(e.target.value || 0) }))}
                fullWidth
              />
              <TextField
                label="Printed Price"
                type="number"
                value={productForm.printed_price ?? 0}
                onChange={(e) => setProductForm((prev) => ({ ...prev, printed_price: Number(e.target.value || 0) }))}
                fullWidth
              />
            </Stack>
            <FormControlLabel
              control={
                <Switch
                  checked={Boolean(productForm.loose_sale_enabled)}
                  onChange={(e) => setProductLooseSaleEnabled(e.target.checked)}
                />
              }
              label="Enable loose stock"
            />
            {productForm.loose_sale_enabled ? (
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                <TextField
                  label="Parent Unit"
                  value={productForm.parent_unit_name || ''}
                  onChange={(e) => setProductForm((prev) => ({ ...prev, parent_unit_name: e.target.value }))}
                  placeholder="Strip"
                  fullWidth
                />
                <TextField
                  label="Loose Unit"
                  value={productForm.child_unit_name || ''}
                  onChange={(e) => setProductForm((prev) => ({ ...prev, child_unit_name: e.target.value }))}
                  placeholder="Tablet"
                  fullWidth
                />
                <TextField
                  label="Units per Parent"
                  type="number"
                  value={productForm.default_conversion_qty ?? ''}
                  onChange={(e) => setProductForm((prev) => ({ ...prev, default_conversion_qty: e.target.value ? Number(e.target.value) : undefined }))}
                  inputProps={{ min: 1, step: 1 }}
                  fullWidth
                />
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProductOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => mSaveProduct.mutate()}
            disabled={!productForm.name.trim() || mSaveProduct.isPending}
          >
            {mSaveProduct.isPending ? 'Saving...' : 'Save Product'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={productBrandOpen} onClose={() => setProductBrandOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Brand</DialogTitle>
        <DialogContent dividers>
          <TextField
            label="Brand Name"
            value={productBrandName}
            onChange={(e) => setProductBrandName(e.target.value)}
            autoFocus
            fullWidth
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProductBrandOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              const name = productBrandName.trim()
              if (!name) return toast.push('Brand name is required', 'error')
              mCreateProductBrand.mutate(name)
            }}
            disabled={mCreateProductBrand.isPending}
          >
            Save Brand
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={productCategoryOpen} onClose={() => setProductCategoryOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Category</DialogTitle>
        <DialogContent dividers>
          <TextField
            label="Category Name"
            value={productCategoryName}
            onChange={(e) => setProductCategoryName(e.target.value)}
            autoFocus
            fullWidth
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProductCategoryOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              const name = productCategoryName.trim()
              if (!name) return toast.push('Category name is required', 'error')
              mCreateProductCategory.mutate(name)
            }}
            disabled={mCreateProductCategory.isPending}
          >
            Save Category
          </Button>
        </DialogActions>
      </Dialog>

      <AdjustStockDialog
        open={adjustId != null}
        itemName={adjustName}
        onClose={() => {
          setAdjustId(null)
          setAdjustName('')
        }}
        onConfirm={(delta) => {
          if (adjustId != null) mAdjust.mutate({ id: adjustId, delta })
          setAdjustId(null)
          setAdjustName('')
        }}
      />
    </Stack>
  )
}
