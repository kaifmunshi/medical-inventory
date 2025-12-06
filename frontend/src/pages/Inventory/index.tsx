// F:\medical-inventory\frontend\src\pages\Inventory\index.tsx
import {
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material'
import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import {
  listItems,
  createItem,
  updateItem,
  deleteItem,
  adjustStock,
} from '../../services/inventory'
import Loading from '../../components/ui/Loading'
import ItemForm from './ItemForm'
import type { ItemFormValues } from './ItemForm'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import AdjustStockDialog from '../../components/ui/AdjustStockDialog'
import { useToast } from '../../components/ui/Toaster'

export default function Inventory() {
  const toast = useToast()

  const [q, setQ] = useState('')
  const [openForm, setOpenForm] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [adjustId, setAdjustId] = useState<number | null>(null)
  const [adjustName, setAdjustName] = useState<string>('')

  // NEW: which item is pending delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)

  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['items', q],
    queryFn: async () => {
      try {
        const res = await listItems(q)
        return res
      } catch (err: any) {
        const msg =
          err?.response?.data?.detail ||
          err?.message ||
          'Failed to load inventory'
        toast.push(String(msg), 'error')
        throw err // rethrow so react-query marks it as an error
      }
    },
  })

  const mCreate = useMutation({
    mutationFn: (payload: ItemFormValues) => createItem(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      toast.push('Item created', 'success')
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail || err?.message || 'Create failed'
      toast.push(String(msg), 'error')
    },
  })

  const mUpdate = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ItemFormValues }) =>
      updateItem(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      toast.push('Item updated', 'success')
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail || err?.message || 'Update failed'
      toast.push(String(msg), 'error')
    },
  })

  const mDelete = useMutation({
    mutationFn: (id: number) => deleteItem(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      toast.push('Item deleted', 'warning')
      setDeleteTarget(null)
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail || err?.message || 'Delete failed'
      toast.push(String(msg), 'error')
    },
  })

  const mAdjust = useMutation({
    mutationFn: ({ id, delta }: { id: number; delta: number }) =>
      adjustStock(id, delta),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      toast.push('Stock adjusted', 'success')
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail ||
        err?.message ||
        'Adjust stock failed'
      toast.push(String(msg), 'error')
    },
  })

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

  // When user clicks trash icon – just open dialog
  function handleDeleteClick(row: any) {
    setDeleteTarget(row)
  }

  // When user confirms delete
  function handleConfirmDelete() {
    if (!deleteTarget) return
    mDelete.mutate(deleteTarget.id)
  }

  // When user cancels dialog
  function handleCancelDelete() {
    setDeleteTarget(null)
  }

  const rows = data || []

  return (
    <Stack gap={2}>
      <Typography variant="h5">Inventory</Typography>
      <Paper sx={{ p: 2 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          gap={2}
          alignItems={{ sm: 'center' }}
        >
          <TextField
            label="Search (name/brand)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
          />
          <Button variant="contained" onClick={handleAdd}>
            Add Item
          </Button>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        {isLoading ? (
          <Loading />
        ) : (
          <Box component="div" sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Brand</th>
                  <th>Expiry</th>
                  <th>MRP</th>
                  <th>Stock</th>
                  <th style={{ width: 140 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((it: any) => (
                  <tr key={it.id}>
                    <td>{it.name}</td>
                    <td>{it.brand || '-'}</td>
                    <td>{it.expiry_date || '-'}</td>
                    <td>{it.mrp}</td>
                    <td>{it.stock}</td>
                    <td>
                      <Stack direction="row" gap={1}>
                        <Tooltip title="Edit">
                          <IconButton
                            size="small"
                            onClick={() => handleEdit(it)}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>

                        <Tooltip title="Adjust Stock">
                          <IconButton
                            size="small"
                            onClick={() => handleAdjust(it)}
                          >
                            <AddCircleOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>

                        <Tooltip title="Delete">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => handleDeleteClick(it)}
                            disabled={mDelete.isPending}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
        )}
      </Paper>

      <ItemForm
        open={openForm}
        initial={editing}
        items={rows} // 🔹 pass existing items for suggestions
        onClose={() => setOpenForm(false)}
        onSubmit={(values) => {
          if (editing?.id) mUpdate.mutate({ id: editing.id, payload: values })
          else mCreate.mutate(values)
          setOpenForm(false)
        }}
      />

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

      {/* Fancy delete confirmation dialog */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={handleCancelDelete}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete Item</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {deleteTarget
              ? `Delete item "${deleteTarget.name}"? This action cannot be undone.`
              : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelDelete}>Cancel</Button>
          <Button
            onClick={handleConfirmDelete}
            color="error"
            variant="contained"
            disabled={mDelete.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
