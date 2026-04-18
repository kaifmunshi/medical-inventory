import { useMemo, useState } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
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
import { createCategory, createProduct, fetchCategories, fetchProducts, updateProduct, type ProductPayload } from '../../services/products'
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
  loose_sale_enabled: false,
  parent_unit_name: '',
  child_unit_name: '',
  default_conversion_qty: undefined,
}

export default function ProductsPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<ProductForm>(emptyForm)
  const [newCategoryName, setNewCategoryName] = useState('')

  const categoriesQ = useQuery<Category[], Error>({
    queryKey: ['product-categories-master', { active_only: false }],
    queryFn: () => fetchCategories({ active_only: false }),
  })

  const productsQ = useQuery<Product[], Error>({
    queryKey: ['products-master', q, categoryFilter, showInactive],
    queryFn: () => fetchProducts({
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
      queryClient.invalidateQueries({ queryKey: ['purchase-products'] })
      closeForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to save product'), 'error'),
  })

  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ProductForm }) => updateProduct(id, payload),
    onSuccess: () => {
      toast.push('Product updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-products'] })
      closeForm()
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update product'), 'error'),
  })

  const categoryM = useMutation({
    mutationFn: createCategory,
    onSuccess: (category) => {
      toast.push('Category saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
      setForm((prev) => ({ ...prev, category_id: Number(category.id) }))
      setNewCategoryName('')
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to save category'), 'error'),
  })

  const categories = categoriesQ.data || []
  const activeCategories = categories.filter((category) => category.is_active)
  const categoryName = (id?: number | null) => categories.find((category) => Number(category.id) === Number(id))?.name || '-'

  const rows = useMemo(() => {
    const products = productsQ.data || []
    return showInactive ? products : products.filter((product) => product.is_active)
  }, [productsQ.data, showInactive])

  function openAdd() {
    setEditing(null)
    setForm(emptyForm)
    setNewCategoryName('')
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
      loose_sale_enabled: Boolean(row.loose_sale_enabled),
      parent_unit_name: row.parent_unit_name || '',
      child_unit_name: row.child_unit_name || '',
      default_conversion_qty: row.default_conversion_qty || undefined,
      is_active: row.is_active,
    })
    setNewCategoryName('')
    setOpen(true)
  }

  function closeForm() {
    setOpen(false)
    setEditing(null)
    setForm(emptyForm)
    setNewCategoryName('')
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
      parent_unit_name: form.parent_unit_name?.trim() || undefined,
      child_unit_name: form.child_unit_name?.trim() || undefined,
      default_conversion_qty: form.default_conversion_qty ? Number(form.default_conversion_qty) : undefined,
    }
    if (!payload.name) {
      toast.push('Product name is required', 'error')
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
    setCategoryFilter(null)
    setShowInactive(false)
  }

  return (
    <Stack gap={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
        <Typography variant="h5">Products</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>Add Product</Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={4}>
            <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} fullWidth />
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField select label="Category" value={categoryFilter ?? ''} onChange={(e) => setCategoryFilter(e.target.value ? Number(e.target.value) : null)} fullWidth>
              <MenuItem value="">All</MenuItem>
              {categories.map((category) => (
                <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={12} md={2}>
            <FormControlLabel control={<Checkbox checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />} label="Show inactive" />
          </Grid>
          <Grid item xs={12} md={3}>
            <Stack direction="row" gap={1} justifyContent={{ md: 'flex-end' }}>
              <Button variant="outlined" onClick={resetFilters}>Reset Filters</Button>
              <Button variant="contained" onClick={openAdd}>Add</Button>
            </Stack>
          </Grid>
        </Grid>
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
                <th>Rack</th>
                <th>Loose</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onDoubleClick={() => openEdit(row)} style={{ cursor: 'pointer', opacity: row.is_active ? 1 : 0.6 }}>
                  <td>{row.name}</td>
                  <td>{row.brand || '-'}</td>
                  <td>{row.alias || '-'}</td>
                  <td>{categoryName(row.category_id)}</td>
                  <td>{row.default_rack_number || 0}</td>
                  <td>{row.loose_sale_enabled ? `${row.parent_unit_name || '-'} -> ${row.child_unit_name || '-'} (${row.default_conversion_qty || '-'})` : '-'}</td>
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
          <Stack gap={2} mt={1}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Product Details</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <TextField label="Name" value={form.name} onChange={(e) => patchForm({ name: e.target.value })} required fullWidth />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField label="Brand" value={form.brand || ''} onChange={(e) => patchForm({ brand: e.target.value })} fullWidth />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField label="Short Name / Alias" value={form.alias || ''} onChange={(e) => patchForm({ alias: e.target.value })} fullWidth />
                </Grid>
                <Grid item xs={12} md={7}>
                  <Autocomplete
                    options={activeCategories}
                    getOptionLabel={(option) => option.name}
                    value={activeCategories.find((category) => Number(category.id) === Number(form.category_id)) || null}
                    onChange={(_, value) => patchForm({ category_id: value ? Number(value.id) : undefined })}
                    renderInput={(params) => <TextField {...params} label="Category" fullWidth />}
                  />
                </Grid>
                <Grid item xs={12} md={5}>
                  <Stack direction="row" gap={1}>
                    <TextField size="small" label="New Category" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} fullWidth />
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={!newCategoryName.trim() || categoryM.isPending}
                      onClick={() => categoryM.mutate(newCategoryName)}
                      sx={{ minWidth: 0, px: 1.25, whiteSpace: 'nowrap' }}
                    >
                      + NEW
                    </Button>
                  </Stack>
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField label="Default Rack" type="number" value={form.default_rack_number || 0} onChange={(e) => patchForm({ default_rack_number: Number(e.target.value) })} fullWidth />
                </Grid>
                {editing && (
                  <Grid item xs={12} md={4}>
                    <TextField select label="Status" value={form.is_active === false ? 'inactive' : 'active'} onChange={(e) => patchForm({ is_active: e.target.value === 'active' })} fullWidth>
                      <MenuItem value="active">Active</MenuItem>
                      <MenuItem value="inactive">Inactive</MenuItem>
                    </TextField>
                  </Grid>
                )}
              </Grid>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Loose Sale Defaults</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12}>
                  <FormControlLabel control={<Checkbox checked={Boolean(form.loose_sale_enabled)} onChange={(e) => patchForm({ loose_sale_enabled: e.target.checked })} />} label="Can be sold loosely" />
                </Grid>
                {form.loose_sale_enabled && (
                  <>
                    <Grid item xs={12} md={4}>
                      <TextField label="Parent Unit" value={form.parent_unit_name || ''} onChange={(e) => patchForm({ parent_unit_name: e.target.value })} fullWidth />
                    </Grid>
                    <Grid item xs={12} md={4}>
                      <TextField label="Child Unit" value={form.child_unit_name || ''} onChange={(e) => patchForm({ child_unit_name: e.target.value })} fullWidth />
                    </Grid>
                    <Grid item xs={12} md={4}>
                      <TextField label="Conversion Qty" type="number" value={form.default_conversion_qty || ''} onChange={(e) => patchForm({ default_conversion_qty: e.target.value ? Number(e.target.value) : undefined })} fullWidth />
                    </Grid>
                  </>
                )}
              </Grid>
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeForm}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={createM.isPending || updateM.isPending}>Save</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
