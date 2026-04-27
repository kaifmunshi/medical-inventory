import { useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLots, fetchPackOpenEvents, openPack } from '../../services/lots'
import type { InventoryLotBrowse, PackOpenEvent } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'

function money(n?: number | null) {
  return Number(n || 0).toFixed(2)
}

function formatDate(dt?: string) {
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

export default function LooseStockPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [rack, setRack] = useState('')
  const [selectedLot, setSelectedLot] = useState<InventoryLotBrowse | null>(null)
  const [packsToOpen, setPacksToOpen] = useState('1')
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState<'openable' | 'loose' | 'all'>('openable')

  const lotsQ = useQuery<InventoryLotBrowse[], Error>({
    queryKey: ['lots', q, rack, filter],
    queryFn: () =>
      fetchLots({
        q: q.trim() || undefined,
        rack_number: rack.trim() ? Number(rack) : undefined,
        openable_only: filter === 'openable',
        loose_only: filter === 'loose',
      }),
  })

  const eventsQ = useQuery<PackOpenEvent[], Error>({
    queryKey: ['pack-open-events'],
    queryFn: () => fetchPackOpenEvents(),
  })

  const openM = useMutation({
    mutationFn: openPack,
    onSuccess: () => {
      toast.push('Pack opened and loose stock created', 'success')
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['pack-open-events'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory'] })
      setSelectedLot(null)
      setPacksToOpen('1')
      setNote('')
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to open pack'), 'error'),
  })

  const lots = lotsQ.data || []
  const events = eventsQ.data || []

  const selectedPreview = useMemo(() => {
    if (!selectedLot) return null
    const packs = Number(packsToOpen || 0)
    const conversion = Number(selectedLot.conversion_qty || 0)
    return packs > 0 && conversion > 0 ? packs * conversion : 0
  }, [selectedLot, packsToOpen])

  function submitOpen() {
    if (!selectedLot) return
    const packs = Number(packsToOpen || 0)
    if (!Number.isFinite(packs) || packs <= 0) {
      toast.push('Enter a valid pack count', 'error')
      return
    }
    openM.mutate({
      lot_id: Number(selectedLot.id),
      packs_opened: packs,
      note: note.trim() || undefined,
    })
  }

  return (
    <Stack gap={2}>
      <Typography variant="h5">Loose Stock</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
          <TextField
            label="Search product / alias / brand / rack"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
          />
          <TextField
            label="Rack"
            value={rack}
            onChange={(e) => setRack(e.target.value.replace(/\D/g, ''))}
            sx={{ width: { xs: '100%', md: 140 } }}
          />
          <TextField
            select
            label="View"
            value={filter}
            onChange={(e) => setFilter(e.target.value as 'openable' | 'loose' | 'all')}
            sx={{ width: { xs: '100%', md: 180 } }}
          >
            <MenuItem value="openable">Openable Lots</MenuItem>
            <MenuItem value="loose">Loose Lots</MenuItem>
            <MenuItem value="all">All Lots</MenuItem>
          </TextField>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Brand</th>
                <th>Rack</th>
                <th>Expiry</th>
                <th>MRP</th>
                <th>Sealed</th>
                <th>Loose</th>
                <th>Units / Pack</th>
                <th>Units</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <tr key={lot.id}>
                  <td>
                    <strong>{lot.product_name}</strong>
                    {lot.alias ? <div style={{ color: '#667085' }}>Alias: {lot.alias}</div> : null}
                  </td>
                  <td>{lot.brand || '-'}</td>
                  <td>{lot.rack_number}</td>
                  <td>{lot.expiry_date || '-'}</td>
                  <td>{money(lot.mrp)}</td>
                  <td>{lot.sealed_qty}</td>
                  <td>{lot.loose_qty}</td>
                  <td>{lot.conversion_qty || '-'}</td>
                  <td>
                    {lot.parent_unit_name || '-'}
                    {lot.child_unit_name ? ` -> ${lot.child_unit_name}` : ''}
                  </td>
                  <td>
                    {lot.loose_sale_enabled && !lot.opened_from_lot_id && lot.sealed_qty > 0 ? (
                      <Button variant="contained" size="small" onClick={() => setSelectedLot(lot)}>
                        Open Pack
                      </Button>
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
              {lots.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <Box p={2} color="text.secondary">No lots found for this view.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Recent Pack Open Events</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Source Lot</th>
                <th>Loose Lot</th>
                <th>Packs Opened</th>
                <th>Loose Units</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.created_at)}</td>
                  <td>{event.source_lot_id}</td>
                  <td>{event.loose_lot_id}</td>
                  <td>{event.packs_opened}</td>
                  <td>{event.loose_units_created}</td>
                  <td>{event.note || '-'}</td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Box p={2} color="text.secondary">No pack-open events yet.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={Boolean(selectedLot)} onClose={() => setSelectedLot(null)} fullWidth maxWidth="sm">
        <DialogTitle>Open Pack</DialogTitle>
        <DialogContent dividers>
          {selectedLot && (
            <Stack gap={2} mt={1}>
              <Typography fontWeight={700}>
                {selectedLot.product_name}{selectedLot.brand ? ` | ${selectedLot.brand}` : ''}
              </Typography>
              <Typography color="text.secondary">
                Available sealed stock: {selectedLot.sealed_qty} {selectedLot.parent_unit_name || 'packs'}
              </Typography>
              <Typography color="text.secondary">
                Conversion: 1 {selectedLot.parent_unit_name || 'pack'} = {selectedLot.conversion_qty || 0} {selectedLot.child_unit_name || 'loose units'}
              </Typography>
              <TextField
                label="How many packs to open?"
                type="number"
                value={packsToOpen}
                onChange={(e) => setPacksToOpen(e.target.value)}
                fullWidth
              />
              <TextField
                label="Note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                fullWidth
                multiline
                minRows={2}
              />
              <Typography>
                Loose stock to create: <strong>{selectedPreview || 0}</strong> {selectedLot.child_unit_name || 'units'}
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedLot(null)}>Cancel</Button>
          <Button variant="contained" onClick={submitOpen} disabled={openM.isPending}>Open</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
