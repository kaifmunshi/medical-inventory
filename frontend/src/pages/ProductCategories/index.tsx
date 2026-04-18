import { useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ArchiveIcon from '@mui/icons-material/Archive'
import UnarchiveIcon from '@mui/icons-material/Unarchive'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createCategory, fetchCategories, updateCategory } from '../../services/products'
import type { Category } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'

function formatDate(dt?: string | null) {
  if (!dt) return '-'
  try {
    return new Date(dt).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return dt
  }
}

export default function ProductCategoriesPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [open, setOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Category | null>(null)
  const [name, setName] = useState('')

  const categoriesQ = useQuery<Category[], Error>({
    queryKey: ['product-categories-master', showInactive],
    queryFn: () => fetchCategories({ active_only: !showInactive }),
  })

  const createM = useMutation({
    mutationFn: createCategory,
    onSuccess: () => {
      toast.push('Category saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-categories'] })
      setOpen(false)
      setName('')
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to save category'), 'error'),
  })

  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { name?: string; is_active?: boolean } }) => updateCategory(id, payload),
    onSuccess: () => {
      toast.push('Category updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-categories'] })
      setEditTarget(null)
      setName('')
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to update category'), 'error'),
  })

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const categories = categoriesQ.data || []
    if (!needle) return categories
    return categories.filter((category) => category.name.toLowerCase().includes(needle))
  }, [categoriesQ.data, q])

  function openAdd() {
    setName('')
    setEditTarget(null)
    setOpen(true)
  }

  function resetFilters() {
    setQ('')
    setShowInactive(false)
  }

  function openEdit(row: Category) {
    setName(row.name)
    setOpen(false)
    setEditTarget(row)
  }

  function saveCreate() {
    const clean = name.trim()
    if (!clean) {
      toast.push('Category name is required', 'error')
      return
    }
    createM.mutate(clean)
  }

  function saveEdit() {
    const clean = name.trim()
    if (!editTarget) return
    if (!clean) {
      toast.push('Category name is required', 'error')
      return
    }
    updateM.mutate({ id: Number(editTarget.id), payload: { name: clean } })
  }

  function toggleActive(row: Category) {
    updateM.mutate({ id: Number(row.id), payload: { is_active: !row.is_active } })
  }

  return (
    <Stack gap={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
        <Typography variant="h5">Product Categories</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
          Add Category
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems={{ md: 'center' }}>
          <TextField
            label="Search categories"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
          />
          <Button variant="outlined" onClick={resetFilters} sx={{ minWidth: 120 }}>
            Reset Filters
          </Button>
          <FormControlLabel
            control={<Switch checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />}
            label="Show inactive"
            sx={{ minWidth: 160 }}
          />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Created</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onDoubleClick={() => openEdit(row)} style={{ cursor: 'pointer' }}>
                  <td>{row.name}</td>
                  <td>
                    <Chip
                      size="small"
                      label={row.is_active ? 'Active' : 'Inactive'}
                      color={row.is_active ? 'success' : 'default'}
                      variant={row.is_active ? 'filled' : 'outlined'}
                    />
                  </td>
                  <td>{formatDate(row.created_at)}</td>
                  <td>{formatDate(row.updated_at)}</td>
                  <td>
                    <Stack direction="row" gap={1}>
                      <IconButton size="small" color={row.is_active ? 'warning' : 'success'} onClick={() => toggleActive(row)}>
                        {row.is_active ? <ArchiveIcon fontSize="small" /> : <UnarchiveIcon fontSize="small" />}
                      </IconButton>
                    </Stack>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <Box p={2} color="text.secondary">No categories found.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Category</DialogTitle>
        <DialogContent dividers>
          <TextField
            label="Category Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            autoFocus
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveCreate} disabled={createM.isPending}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(editTarget)} onClose={() => setEditTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Edit Category</DialogTitle>
        <DialogContent dividers>
          <TextField
            label="Category Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            autoFocus
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveEdit} disabled={updateM.isPending}>Update</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
