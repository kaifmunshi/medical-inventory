// F:\medical-inventory\frontend\src\components\billing\ItemPicker.tsx
import { useEffect, useState } from 'react'
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  TextField,
  List,
  ListItemButton,
  ListItemText,
  DialogActions,
  Button,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { listItems } from '../../services/inventory'
import { useToast } from '../ui/Toaster'

export interface PickerItem {
  id: number
  name: string
  mrp: number
  stock: number
  brand?: string | null
}

export default function ItemPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (it: PickerItem) => void
}) {
  const toast = useToast()
  const [q, setQ] = useState('')

  const { data } = useQuery({
    queryKey: ['billing-items', q],
    // keep functionality, just surface fetch errors as toast
    queryFn: async () => {
      try {
        return await listItems(q)
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || 'Failed to load items'
        toast.push(String(msg), 'error')
        throw err
      }
    },
  })

  const items = (data || []) as PickerItem[]

  useEffect(() => {
    if (!open) setQ('')
  }, [open])

  function handlePick(it: PickerItem) {
    if (it.stock <= 0) {
      toast.push('Not enough stock', 'warning')
      return
    }
    onPick(it)
    toast.push('Item added', 'success')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Select Item</DialogTitle>
      <DialogContent>
        <Box my={1}>
          <TextField
            fullWidth
            autoFocus
            placeholder="Search (name/brand)"   // ✅ updated placeholder
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </Box>

        <List>
          {items.map((it) => (
            <ListItemButton
              key={it.id}
              disabled={it.stock <= 0}
              onClick={() => handlePick(it)}
            >
              <ListItemText
                primary={`${it.name} — ₹${it.mrp}`}
                secondary={`Stock: ${it.stock}${it.brand ? ` • ${it.brand}` : ''}`}
              />
            </ListItemButton>
          ))}
          {items.length === 0 && (
            <Box p={2} color="text.secondary">
              No items found.
            </Box>
          )}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
