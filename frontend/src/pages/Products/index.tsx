import { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ArchiveIcon from '@mui/icons-material/Archive'
import UnarchiveIcon from '@mui/icons-material/Unarchive'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  createProduct,
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
}

export default function ProductsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [q, setQ] = useState(searchParams.get('q') || '')
  const [brandFilter, setBrandFilter] = useState(searchParams.get('brand') || '')
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<ProductForm>(emptyForm)

  useEffect(() => {
    setQ(searchParams.get('q') || '')
    setBrandFilter(searchParams.get('brand') || '')
  }, [searchParams])

  const categoriesQ = useQuery<Category[], Error>({
    queryKey: ['product-categories-master', { active_only: false }],
    queryFn: () => fetchCategories({ active_only: false }),
  })

  const brandsQ = useQuery({
    queryKey: ['brand-master', { active_only: true }],
    queryFn: () => fetchBrands({ active_only: true }),
  })

  const productsQ = useQuery<Product[], Error>({
    queryKey: ['products-master', q, categoryFilter, showInactive],
    queryFn: () =>
      fetchProducts({
        q: q.trim() || undefined,
        category_id: categoryFilter || undefined,
        active_only: !showInactive,
      }),
  })

  const createM = useMutation({
    mutationFn: createProduct,
    onSuccess: () => {
      toast.push('Product saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      closeForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to save product'), 'error'),
  })

  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ProductForm }) => updateProduct(id, payload),
    onSuccess: () => {
      toast.push('Product updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      closeForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update product'), 'error'),
  })

  const categories = categoriesQ.data || []
  const brandNames = (brandsQ.data || []).map((brand) => brand.name)
  const categoryName = (id?: number | null) => categories.find((category) => Number(category.id) === Number(id))?.name || '-'

  const rows = useMemo(() => {
    const products = productsQ.data || []
    const activeRows = showInactive ? products : products.filter((product) => product.is_active)
    if (!brandFilter.trim()) return activeRows
    return activeRows.filter((product) => String(product.brand || '').toLowerCase() === brandFilter.trim().toLowerCase())
  }, [productsQ.data, showInactive, brandFilter])

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
      is_active: row.is_active,
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

  function save() {
    const payload: ProductForm = {
      ...form,
      name: form.name.trim(),
      alias: form.alias?.trim() || undefined,
      brand: form.brand?.trim() || undefined,
      category_id: form.category_id || undefined,
      default_rack_number: Number(form.default_rack_number || 0),
      printed_price: Number(form.printed_price || 0),
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

  function toggleActive(row: Product) {
    updateM.mutate({ id: Number(row.id), payload: { name: row.name, is_active: !row.is_active } as ProductForm })
  }

  function resetFilters() {
    setQ('')
    setBrandFilter('')
    setCategoryFilter(null)
    setShowInactive(false)
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
          <TextField label="Brand" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} sx={{ minWidth: 180 }} />
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
          <TextField
            select
            label="Status"
            value={showInactive ? 'all' : 'active'}
            onChange={(e) => setShowInactive(e.target.value === 'all')}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="active">Active only</MenuItem>
            <MenuItem value="all">All products</MenuItem>
          </TextField>
          <Button variant="outlined" onClick={resetFilters}>
            Reset
          </Button>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1} sx={{ mb: 1.5 }}>
          <Typography variant="subtitle1" fontWeight={700}>Product List</Typography>
          <Typography variant="body2" color="text.secondary">{rows.length} products</Typography>
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
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onDoubleClick={() => openEdit(row)} style={{ cursor: 'pointer', opacity: row.is_active ? 1 : 0.65 }}>
                  <td>{row.name}</td>
                  <td>{row.brand || '-'}</td>
                  <td>{row.alias || '-'}</td>
                  <td>{categoryName(row.category_id)}</td>
                  <td>{row.default_rack_number || 0}</td>
                  <td>{Number(row.printed_price || 0).toFixed(2)}</td>
                  <td>{row.is_active ? 'Active' : 'Inactive'}</td>
                  <td>
                    <Stack direction="row" gap={1}>
                      <Button size="small" onClick={() => openEdit(row)}>Edit</Button>
                      <IconButton size="small" onClick={() => toggleActive(row)}>
                        {row.is_active ? <ArchiveIcon fontSize="small" /> : <UnarchiveIcon fontSize="small" />}
                      </IconButton>
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
              <Autocomplete
                freeSolo
                options={brandNames}
                value={form.brand || ''}
                onChange={(_, value) => patchForm({ brand: typeof value === 'string' ? value : value || '' })}
                onInputChange={(_, value) => patchForm({ brand: value })}
                renderInput={(params) => <TextField {...params} label="Brand" fullWidth helperText="Choose from Brand Master or type a new one" />}
                sx={{ flex: 1 }}
              />
              <TextField
                select
                label="Category"
                value={form.category_id ?? ''}
                onChange={(e) => patchForm({ category_id: e.target.value ? Number(e.target.value) : undefined })}
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">No category</MenuItem>
                {categories.map((category) => (
                  <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>
                ))}
              </TextField>
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
              {editing ? (
                <TextField
                  select
                  label="Status"
                  value={form.is_active === false ? 'inactive' : 'active'}
                  onChange={(e) => patchForm({ is_active: e.target.value === 'active' })}
                  sx={{ minWidth: 180 }}
                >
                  <MenuItem value="active">Active</MenuItem>
                  <MenuItem value="inactive">Inactive</MenuItem>
                </TextField>
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
    </Stack>
  )
}
