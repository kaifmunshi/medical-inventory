import { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Pagination,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CallMergeIcon from '@mui/icons-material/CallMerge'
import DeleteIcon from '@mui/icons-material/Delete'
import KeyboardDoubleArrowDownIcon from '@mui/icons-material/KeyboardDoubleArrowDown'
import KeyboardDoubleArrowUpIcon from '@mui/icons-material/KeyboardDoubleArrowUp'
import RestoreFromTrashIcon from '@mui/icons-material/RestoreFromTrash'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  notifyProductMasterChanged,
  subscribeProductMasterChanged,
} from '../../lib/productMasterEvents'
import {
  createProduct,
  createBrand,
  createCategory,
  deleteProduct,
  fetchBrands,
  fetchCategories,
  fetchProducts,
  fetchProductsPage,
  mergeProduct,
  type ProductPage,
  type ProductPayload,
  updateProduct,
} from '../../services/products'
import type { Category, Product } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'

type ProductForm = ProductPayload & {
  is_active?: boolean
}

const emptyForm: ProductForm = {
  name: '',
  alias: '',
  brand: '',
  category_id: undefined,
  default_rack_number: 0,
  printed_price: 0,
  loose_sale_enabled: false,
  parent_unit_name: '',
  child_unit_name: '',
  default_conversion_qty: undefined,
}

export default function ProductsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [q, setQ] = useState(searchParams.get('q') || '')
  const [brandFilter, setBrandFilter] = useState(searchParams.get('brand') || '')
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(25)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<ProductForm>(emptyForm)
  const [brandDialogOpen, setBrandDialogOpen] = useState(false)
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [mergeSource, setMergeSource] = useState<Product | null>(null)
  const [mergeTarget, setMergeTarget] = useState<Product | null>(null)
  const [mergeSearch, setMergeSearch] = useState('')
  const [newBrandName, setNewBrandName] = useState('')
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showScrollJumps, setShowScrollJumps] = useState(false)

  useEffect(() => {
    setQ(searchParams.get('q') || '')
    setBrandFilter(searchParams.get('brand') || '')
  }, [searchParams])

  useEffect(() => {
    setPage(0)
  }, [q, brandFilter, categoryFilter, rowsPerPage, showInactive])

  useEffect(() => {
    return subscribeProductMasterChanged(() => {
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['product-merge-options'] })
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
    })
  }, [queryClient])

  useEffect(() => {
    let hideTimer: number | undefined

    function pageCanScroll() {
      return document.documentElement.scrollHeight > window.innerHeight + 8
    }

    function revealScrollJumps() {
      if (!pageCanScroll()) {
        setShowScrollJumps(false)
        return
      }
      setShowScrollJumps(true)
      if (hideTimer) window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => setShowScrollJumps(false), 1600)
    }

    function handleResize() {
      if (!pageCanScroll()) setShowScrollJumps(false)
    }

    window.addEventListener('scroll', revealScrollJumps, { passive: true })
    window.addEventListener('resize', handleResize)
    return () => {
      if (hideTimer) window.clearTimeout(hideTimer)
      window.removeEventListener('scroll', revealScrollJumps)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const categoriesQ = useQuery<Category[], Error>({
    queryKey: ['product-categories-master', { active_only: false }],
    queryFn: () => fetchCategories({ active_only: false }),
  })

  const brandsQ = useQuery({
    queryKey: ['brand-master', { active_only: true }],
    queryFn: () => fetchBrands({ active_only: true }),
  })

  const productsQ = useQuery<ProductPage, Error>({
    queryKey: ['products-master', q, brandFilter, categoryFilter, showInactive, page, rowsPerPage],
    queryFn: () =>
      fetchProductsPage({
        q: q.trim() || undefined,
        brand: brandFilter.trim() || undefined,
        category_id: categoryFilter || undefined,
        active_only: !showInactive,
        inactive_only: showInactive,
        limit: rowsPerPage,
        offset: page * rowsPerPage,
      }),
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
    staleTime: 0,
  })

  const mergeOptionsQ = useQuery<Product[], Error>({
    queryKey: ['product-merge-options', mergeSource?.id, mergeSearch],
    queryFn: () =>
      fetchProducts({
        q: mergeSearch.trim() || mergeSource?.name || undefined,
        active_only: false,
        limit: 50,
      }),
    enabled: Boolean(mergeSource),
  })

  const createM = useMutation({
    mutationFn: createProduct,
    onSuccess: () => {
      toast.push('Product saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      notifyProductMasterChanged()
      closeForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to save product'), 'error'),
  })

  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ProductForm }) => updateProduct(id, payload),
    onSuccess: () => {
      toast.push('Product updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      notifyProductMasterChanged()
      closeForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update product'), 'error'),
  })

  const deleteM = useMutation({
    mutationFn: (id: number) => deleteProduct(id),
    onSuccess: () => {
      toast.push('Product deleted', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-products-master'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      notifyProductMasterChanged()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to delete product'), 'error'),
  })

  const restoreM = useMutation({
    mutationFn: (id: number) => updateProduct(id, { is_active: true }),
    onSuccess: () => {
      toast.push('Product restored', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-products-master'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      notifyProductMasterChanged()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to restore product'), 'error'),
  })

  const mergeM = useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: number; targetId: number }) => mergeProduct(sourceId, targetId),
    onSuccess: (result) => {
      toast.push(
        `Merged product. Moved ${result.moved_items} stock rows and ${result.moved_purchase_items} purchase rows.`,
        'success',
      )
      setMergeSource(null)
      setMergeTarget(null)
      setMergeSearch('')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['product-merge-options'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-products-master'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      notifyProductMasterChanged()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to merge product'), 'error'),
  })

  const categories = categoriesQ.data || []
  const createBrandM = useMutation({
    mutationFn: createBrand,
    onSuccess: (brand) => {
      toast.push('Brand added', 'success')
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
      notifyProductMasterChanged()
      patchForm({ brand: brand.name })
      setNewBrandName('')
      setBrandDialogOpen(false)
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to add brand'), 'error'),
  })

  const createCategoryM = useMutation({
    mutationFn: createCategory,
    onSuccess: (category) => {
      toast.push('Category added', 'success')
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
      queryClient.invalidateQueries({ queryKey: ['billing-product-categories'] })
      notifyProductMasterChanged()
      patchForm({ category_id: Number(category.id) })
      setNewCategoryName('')
      setCategoryDialogOpen(false)
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to add category'), 'error'),
  })

  const brandNames = (brandsQ.data || []).map((brand) => brand.name)
  const categoryName = (id?: number | null) => categories.find((category) => Number(category.id) === Number(id))?.name || '-'

  const rows = useMemo(() => {
    return productsQ.data?.items || []
  }, [productsQ.data?.items])
  const totalProducts = productsQ.data?.total || 0
  const totalPages = Math.max(1, Math.ceil(totalProducts / rowsPerPage))
  const pageStart = rows.length > 0 ? page * rowsPerPage + 1 : 0
  const pageEnd = rows.length > 0 ? page * rowsPerPage + rows.length : 0
  const mergeOptions = useMemo(() => {
    const sourceId = Number(mergeSource?.id || 0)
    return (mergeOptionsQ.data || []).filter((product) => Number(product.id) !== sourceId)
  }, [mergeOptionsQ.data, mergeSource?.id])

  useEffect(() => {
    if (productsQ.isFetching) return
    if (totalProducts === 0 && page !== 0) setPage(0)
    else if (page > totalPages - 1) setPage(totalPages - 1)
  }, [page, productsQ.isFetching, totalPages, totalProducts])

  function openAdd() {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  function openEdit(row: Product) {
    setEditing(row)
    setForm({
      name: row.name,
      alias: row.alias || '',
      brand: row.brand || '',
      category_id: row.category_id || undefined,
      default_rack_number: row.default_rack_number || 0,
      printed_price: row.printed_price || 0,
      loose_sale_enabled: Boolean(row.loose_sale_enabled),
      parent_unit_name: row.parent_unit_name || '',
      child_unit_name: row.child_unit_name || '',
      default_conversion_qty: row.default_conversion_qty || undefined,
    })
    setOpen(true)
  }

  function closeForm() {
    setOpen(false)
    setEditing(null)
    setForm(emptyForm)
  }

  function patchForm(patch: Partial<ProductForm>) {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  function setLooseSaleEnabled(next: boolean) {
    if (!next && form.loose_sale_enabled) {
      const ok = window.confirm(
        'Disable loose stock for this product? New parent units cannot be opened after this, but existing loose stock, bills, returns, and ledgers will remain usable.'
      )
      if (!ok) return
    }
    patchForm({ loose_sale_enabled: next })
  }

  function save() {
    const payload: ProductForm = {
      ...form,
      name: form.name.trim(),
      alias: form.alias?.trim() || undefined,
      brand: form.brand?.trim() || undefined,
      category_id: form.category_id || undefined,
      default_rack_number: Number(form.default_rack_number || 0),
      printed_price: Number(form.printed_price || 0),
      loose_sale_enabled: Boolean(form.loose_sale_enabled),
      parent_unit_name: form.loose_sale_enabled ? form.parent_unit_name?.trim() || undefined : undefined,
      child_unit_name: form.loose_sale_enabled ? form.child_unit_name?.trim() || undefined : undefined,
      default_conversion_qty: form.loose_sale_enabled ? Number(form.default_conversion_qty || 1) : undefined,
    }
    if (!payload.name) {
      toast.push('Product name is required', 'error')
      return
    }
    if (payload.default_rack_number! < 0) {
      toast.push('Default rack cannot be negative', 'error')
      return
    }
    if (payload.printed_price! < 0) {
      toast.push('Printed price cannot be negative', 'error')
      return
    }
    if (editing) updateM.mutate({ id: Number(editing.id), payload })
    else createM.mutate(payload)
  }

  function resetFilters() {
    setQ('')
    setBrandFilter('')
    setCategoryFilter(null)
    setPage(0)
  }

  function scrollToPageTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function scrollToPageBottom() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  }

  function renderPager(position: 'top' | 'bottom') {
    return (
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        gap={1}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', md: 'center' }}
        sx={{ mt: position === 'bottom' ? 1.5 : 0, mb: position === 'top' ? 1.5 : 0 }}
      >
        <Stack direction="row" gap={0.5} alignItems="center" justifyContent={{ xs: 'space-between', md: 'flex-start' }}>
          <Typography variant="body2" color="text.secondary">
            Showing {pageStart}-{pageEnd} of {totalProducts}
          </Typography>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="flex-end">
          <TextField
            select
            size="small"
            label="Rows"
            value={rowsPerPage}
            onChange={(e) => {
              setRowsPerPage(Number(e.target.value))
              setPage(0)
            }}
            sx={{ width: { xs: '100%', sm: 110 } }}
          >
            <MenuItem value={10}>10</MenuItem>
            <MenuItem value={25}>25</MenuItem>
            <MenuItem value={50}>50</MenuItem>
          </TextField>
          <Pagination
            color="primary"
            count={totalPages}
            disabled={productsQ.isFetching}
            page={page + 1}
            onChange={(_, nextPage) => setPage(nextPage - 1)}
            showFirstButton
            showLastButton
            siblingCount={1}
            boundaryCount={1}
            sx={{
              '& .MuiPagination-ul': {
                justifyContent: { xs: 'center', sm: 'flex-end' },
              },
            }}
          />
        </Stack>
      </Stack>
    )
  }

  function saveQuickBrand() {
    const name = newBrandName.trim()
    if (!name) {
      toast.push('Brand name is required', 'error')
      return
    }
    createBrandM.mutate(name)
  }

  function saveQuickCategory() {
    const name = newCategoryName.trim()
    if (!name) {
      toast.push('Category name is required', 'error')
      return
    }
    createCategoryM.mutate(name)
  }

  function deleteRow(row: Product) {
    const ok = window.confirm(`Delete product "${row.name}" only if it has no stock or purchase links. If this duplicate came from a purchase, use Merge instead.`)
    if (ok) deleteM.mutate(Number(row.id))
  }

  function openMerge(row: Product) {
    setMergeSource(row)
    setMergeTarget(null)
    setMergeSearch(row.name)
  }

  function closeMerge() {
    setMergeSource(null)
    setMergeTarget(null)
    setMergeSearch('')
  }

  function submitMerge() {
    if (!mergeSource || !mergeTarget) return
    const ok = window.confirm(
      `Merge "${mergeSource.name}" into "${mergeTarget.name}"? Stock batches, lots, and purchase rows will move to the target product.`
    )
    if (ok) mergeM.mutate({ sourceId: Number(mergeSource.id), targetId: Number(mergeTarget.id) })
  }

  return (
    <Stack gap={2}>
      <Box
        sx={(theme) => ({
          position: 'fixed',
          right: { xs: 6, sm: 10 },
          top: '50%',
          transform: 'translateY(-50%)',
          zIndex: theme.zIndex.tooltip,
          opacity: showScrollJumps ? 1 : 0,
          pointerEvents: showScrollJumps ? 'auto' : 'none',
          transition: 'opacity 160ms ease',
        })}
      >
        <Stack
          gap={0.5}
          sx={(theme) => ({
            bgcolor: 'background.paper',
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 1,
            boxShadow: theme.shadows[3],
            p: 0.25,
          })}
        >
          <Tooltip title="Top of page" placement="left">
            <IconButton size="small" onClick={scrollToPageTop} aria-label="Top of page">
              <KeyboardDoubleArrowUpIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Bottom of page" placement="left">
            <IconButton size="small" onClick={scrollToPageBottom} aria-label="Bottom of page">
              <KeyboardDoubleArrowDownIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
        <Typography variant="h5">Manage Product</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
          Add Product
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems={{ md: 'center' }}>
          <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} fullWidth />
          <TextField
            select
            label="Brand"
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All</MenuItem>
            {brandNames.map((brand) => (
              <MenuItem key={brand} value={brand}>{brand}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Category"
            value={categoryFilter ?? ''}
            onChange={(e) => setCategoryFilter(e.target.value ? Number(e.target.value) : null)}
            sx={{ minWidth: 220 }}
          >
            <MenuItem value="">All</MenuItem>
            {categories.map((category) => (
              <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>
            ))}
          </TextField>
          <Button variant="outlined" onClick={resetFilters}>
            Reset
          </Button>
          <FormControlLabel
            control={
              <Switch
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
            }
            label="Deleted only"
            sx={{ whiteSpace: 'nowrap' }}
          />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1} sx={{ mb: 1.5 }}>
          <Typography variant="subtitle1" fontWeight={700}>Product List</Typography>
          <Typography variant="body2" color="text.secondary">
            Page {page + 1} of {totalPages} • {rows.length} products
          </Typography>
        </Stack>
        {renderPager('top')}
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Brand</th>
                <th>Alias</th>
                <th>Category</th>
                <th>Default Rack</th>
                <th>Printed Price</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onDoubleClick={() => openEdit(row)}
                  style={{
                    cursor: 'pointer',
                    background: row.is_active ? undefined : '#ffebee',
                    opacity: row.is_active ? 1 : 0.9,
                  }}
                >
                  <td>{row.name}</td>
                  <td>{row.brand || '-'}</td>
                  <td>{row.alias || '-'}</td>
                  <td>{categoryName(row.category_id)}</td>
                  <td>{row.default_rack_number || 0}</td>
                  <td>{Number(row.printed_price || 0).toFixed(2)}</td>
                  <td>{row.is_active ? 'Active' : 'Deleted'}</td>
                  <td>
                    <Stack direction="row" gap={1}>
                      <Button size="small" onClick={() => openEdit(row)}>Edit</Button>
                      <Button
                        size="small"
                        startIcon={<CallMergeIcon fontSize="small" />}
                        disabled={mergeM.isPending}
                        onClick={(event) => {
                          event.stopPropagation()
                          openMerge(row)
                        }}
                      >
                        Merge
                      </Button>
                      {row.is_active ? (
                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteIcon fontSize="small" />}
                          disabled={deleteM.isPending}
                          onClick={(event) => {
                            event.stopPropagation()
                            deleteRow(row)
                          }}
                        >
                          Delete
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          startIcon={<RestoreFromTrashIcon fontSize="small" />}
                          disabled={restoreM.isPending}
                          onClick={(event) => {
                            event.stopPropagation()
                            restoreM.mutate(Number(row.id))
                          }}
                        >
                          Restore
                        </Button>
                      )}
                    </Stack>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <Box p={2} color="text.secondary">No products found.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
        {renderPager('bottom')}
      </Paper>

      <Dialog open={open} onClose={closeForm} fullWidth maxWidth="md">
        <DialogTitle>{editing ? 'Edit Product' : 'Add Product'}</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ mt: 1 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <TextField
                label="Product Name"
                value={form.name}
                onChange={(e) => patchForm({ name: e.target.value })}
                fullWidth
                required
              />
              <TextField
                label="Alias"
                value={form.alias || ''}
                onChange={(e) => patchForm({ alias: e.target.value })}
                fullWidth
              />
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <Stack direction="row" gap={1} sx={{ flex: 1 }}>
                <Autocomplete
                  freeSolo
                  options={brandNames}
                  value={form.brand || ''}
                  onChange={(_, value) => patchForm({ brand: typeof value === 'string' ? value : value || '' })}
                  onInputChange={(_, value) => patchForm({ brand: value })}
                  renderInput={(params) => <TextField {...params} label="Brand" fullWidth helperText="Choose or add a brand" />}
                  sx={{ flex: 1 }}
                />
                <Button variant="outlined" onClick={() => setBrandDialogOpen(true)} sx={{ height: 40, whiteSpace: 'nowrap' }}>New</Button>
              </Stack>
              <Stack direction="row" gap={1} sx={{ flex: 1 }}>
                <TextField
                  select
                  label="Category"
                  value={form.category_id ?? ''}
                  onChange={(e) => patchForm({ category_id: e.target.value ? Number(e.target.value) : undefined })}
                  fullWidth
                >
                  <MenuItem value="">No category</MenuItem>
                  {categories.map((category) => (
                    <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>
                  ))}
                </TextField>
                <Button variant="outlined" onClick={() => setCategoryDialogOpen(true)} sx={{ height: 40, whiteSpace: 'nowrap' }}>New</Button>
              </Stack>
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <TextField
                label="Default Rack"
                type="number"
                value={form.default_rack_number ?? 0}
                onChange={(e) => patchForm({ default_rack_number: Number(e.target.value) })}
                inputProps={{ min: 0, step: 1 }}
                sx={{ minWidth: 200 }}
              />
              <TextField
                label="Printed Price"
                type="number"
                value={form.printed_price ?? 0}
                onChange={(e) => patchForm({ printed_price: Number(e.target.value) })}
                inputProps={{ min: 0, step: '0.01' }}
                sx={{ minWidth: 220 }}
              />
            </Stack>
            <Stack spacing={1}>
              <FormControlLabel
                control={
                  <Switch
                    checked={Boolean(form.loose_sale_enabled)}
                    onChange={(e) => setLooseSaleEnabled(e.target.checked)}
                  />
                }
                label="Enable loose stock"
              />
              {form.loose_sale_enabled ? (
                <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
                  <TextField
                    label="Parent Unit"
                    value={form.parent_unit_name || ''}
                    onChange={(e) => patchForm({ parent_unit_name: e.target.value })}
                    placeholder="Strip"
                    fullWidth
                  />
                  <TextField
                    label="Loose Unit"
                    value={form.child_unit_name || ''}
                    onChange={(e) => patchForm({ child_unit_name: e.target.value })}
                    placeholder="Tablet"
                    fullWidth
                  />
                  <TextField
                    label="Units per Parent"
                    type="number"
                    value={form.default_conversion_qty ?? ''}
                    onChange={(e) => patchForm({ default_conversion_qty: e.target.value ? Number(e.target.value) : undefined })}
                    inputProps={{ min: 1, step: 1 }}
                    fullWidth
                  />
                </Stack>
              ) : null}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeForm}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={createM.isPending || updateM.isPending}>
            {editing ? 'Update' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(mergeSource)} onClose={closeMerge} fullWidth maxWidth="sm">
        <DialogTitle>Merge Duplicate Product</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ mt: 1 }}>
            <TextField
              label="Duplicate"
              value={mergeSource ? `#${mergeSource.id} • ${mergeSource.name}${mergeSource.brand ? ` • ${mergeSource.brand}` : ''}` : ''}
              fullWidth
              disabled
            />
            <Autocomplete
              options={mergeOptions}
              value={mergeTarget}
              loading={mergeOptionsQ.isFetching}
              onChange={(_, value) => setMergeTarget(value)}
              onInputChange={(_, value) => setMergeSearch(value)}
              getOptionLabel={(option) => `#${option.id} • ${option.name}${option.brand ? ` • ${option.brand}` : ''}${option.is_active ? '' : ' • deleted'}`}
              isOptionEqualToValue={(option, value) => Number(option.id) === Number(value.id)}
              renderInput={(params) => <TextField {...params} label="Merge Into" autoFocus />}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeMerge}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<CallMergeIcon />}
            onClick={submitMerge}
            disabled={!mergeSource || !mergeTarget || mergeM.isPending}
          >
            {mergeM.isPending ? 'Merging...' : 'Merge'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={brandDialogOpen} onClose={() => setBrandDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Brand</DialogTitle>
        <DialogContent dividers>
          <TextField label="Brand Name" value={newBrandName} onChange={(e) => setNewBrandName(e.target.value)} autoFocus fullWidth sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBrandDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuickBrand} disabled={createBrandM.isPending}>Save Brand</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={categoryDialogOpen} onClose={() => setCategoryDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Category</DialogTitle>
        <DialogContent dividers>
          <TextField label="Category Name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} autoFocus fullWidth sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCategoryDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuickCategory} disabled={createCategoryM.isPending}>Save Category</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
