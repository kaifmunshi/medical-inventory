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
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  createProduct,
  createBrand,
  createCategory,
  fetchBrands,
  fetchCategories,
  fetchProducts,
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
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(25)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<ProductForm>(emptyForm)
  const [brandDialogOpen, setBrandDialogOpen] = useState(false)
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [newBrandName, setNewBrandName] = useState('')
  const [newCategoryName, setNewCategoryName] = useState('')

  useEffect(() => {
    setQ(searchParams.get('q') || '')
    setBrandFilter(searchParams.get('brand') || '')
  }, [searchParams])

  useEffect(() => {
    setPage(0)
  }, [q, brandFilter, categoryFilter, rowsPerPage])

  const categoriesQ = useQuery<Category[], Error>({
    queryKey: ['product-categories-master', { active_only: false }],
    queryFn: () => fetchCategories({ active_only: false }),
  })

  const brandsQ = useQuery({
    queryKey: ['brand-master', { active_only: true }],
    queryFn: () => fetchBrands({ active_only: true }),
  })

  const productsQ = useQuery<Product[], Error>({
    queryKey: ['products-master', q, brandFilter, categoryFilter, page, rowsPerPage],
    queryFn: () =>
      fetchProducts({
        q: q.trim() || undefined,
        brand: brandFilter.trim() || undefined,
        category_id: categoryFilter || undefined,
        active_only: true,
        limit: rowsPerPage + 1,
        offset: page * rowsPerPage,
      }),
  })

  const createM = useMutation({
    mutationFn: createProduct,
    onSuccess: () => {
      toast.push('Product saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
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
      closeForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update product'), 'error'),
  })

  const categories = categoriesQ.data || []
  const createBrandM = useMutation({
    mutationFn: createBrand,
    onSuccess: (brand) => {
      toast.push('Brand added', 'success')
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
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
      patchForm({ category_id: Number(category.id) })
      setNewCategoryName('')
      setCategoryDialogOpen(false)
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to add category'), 'error'),
  })

  const brandNames = (brandsQ.data || []).map((brand) => brand.name)
  const categoryName = (id?: number | null) => categories.find((category) => Number(category.id) === Number(id))?.name || '-'

  const rows = useMemo(() => {
    return (productsQ.data || []).slice(0, rowsPerPage)
  }, [productsQ.data, rowsPerPage])
  const hasNextPage = (productsQ.data || []).length > rowsPerPage

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

  return (
    <Stack gap={2}>
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
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1} sx={{ mb: 1.5 }}>
          <Typography variant="subtitle1" fontWeight={700}>Product List</Typography>
          <Typography variant="body2" color="text.secondary">
            Page {page + 1} • {rows.length} products
          </Typography>
        </Stack>
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onDoubleClick={() => openEdit(row)} style={{ cursor: 'pointer' }}>
                  <td>{row.name}</td>
                  <td>{row.brand || '-'}</td>
                  <td>{row.alias || '-'}</td>
                  <td>{categoryName(row.category_id)}</td>
                  <td>{row.default_rack_number || 0}</td>
                  <td>{Number(row.printed_price || 0).toFixed(2)}</td>
                  <td>
                    <Stack direction="row" gap={1}>
                      <Button size="small" onClick={() => openEdit(row)}>Edit</Button>
                    </Stack>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <Box p={2} color="text.secondary">No products found.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} justifyContent="flex-end" alignItems={{ sm: 'center' }} sx={{ mt: 1.5 }}>
          <TextField
            select
            size="small"
            label="Rows"
            value={rowsPerPage}
            onChange={(e) => {
              setRowsPerPage(Number(e.target.value))
              setPage(0)
            }}
            sx={{ width: 110 }}
          >
            <MenuItem value={10}>10</MenuItem>
            <MenuItem value={25}>25</MenuItem>
            <MenuItem value={50}>50</MenuItem>
          </TextField>
          <Button size="small" variant="outlined" disabled={page === 0 || productsQ.isFetching} onClick={() => setPage((prev) => Math.max(0, prev - 1))}>
            Previous
          </Button>
          <Button size="small" variant="outlined" disabled={!hasNextPage || productsQ.isFetching} onClick={() => setPage((prev) => prev + 1)}>
            Next
          </Button>
        </Stack>
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
