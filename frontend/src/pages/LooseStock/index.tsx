import { useEffect, useMemo, useState } from 'react'
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
import { useSearchParams } from 'react-router-dom'
import { closePack, fetchLots, fetchPackOpenEvents, openPack } from '../../services/lots'
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

function parentUnit(lot?: InventoryLotBrowse | null) {
  return lot?.parent_unit_name || 'Pack'
}

function childUnit(lot?: InventoryLotBrowse | null) {
  return lot?.child_unit_name || 'Unit'
}

function filterFromParam(value?: string | null): 'openable' | 'loose' | 'all' {
  return value === 'openable' || value === 'loose' || value === 'all' ? value : 'all'
}

function productIdFromParam(value?: string | null) {
  const id = Number(value || 0)
  return Number.isFinite(id) && id > 0 ? id : undefined
}

export default function LooseStockPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const urlParams = searchParams.toString()
  const [q, setQ] = useState(() => (searchParams.get('q') || '').trim())
  const [rack, setRack] = useState('')
  const [productIdFilter, setProductIdFilter] = useState<number | undefined>(() => productIdFromParam(searchParams.get('product_id')))
  const [selectedLot, setSelectedLot] = useState<InventoryLotBrowse | null>(null)
  const [selectedCloseLot, setSelectedCloseLot] = useState<InventoryLotBrowse | null>(null)
  const [packsToOpen, setPacksToOpen] = useState('1')
  const [packsToClose, setPacksToClose] = useState('1')
  const [note, setNote] = useState('')
  const [closeNote, setCloseNote] = useState('')
  const [filter, setFilter] = useState<'openable' | 'loose' | 'all'>(() => filterFromParam(searchParams.get('filter')))

  useEffect(() => {
    setQ((searchParams.get('q') || '').trim())
    setProductIdFilter(productIdFromParam(searchParams.get('product_id')))
    setFilter(filterFromParam(searchParams.get('filter')))
  }, [urlParams])

  const lotsQ = useQuery<InventoryLotBrowse[], Error>({
    queryKey: ['lots', q, rack, filter, productIdFilter],
    queryFn: () =>
      fetchLots({
        q: q.trim() || undefined,
        product_id: productIdFilter,
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
      toast.push('Parent unit opened and loose stock created', 'success')
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

  const closeM = useMutation({
    mutationFn: closePack,
    onSuccess: () => {
      toast.push('Loose stock closed back into parent unit', 'success')
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['pack-open-events'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory'] })
      setSelectedCloseLot(null)
      setPacksToClose('1')
      setCloseNote('')
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to close pack'), 'error'),
  })

  const lots = (lotsQ.data || []).filter((lot) => (
    !lot.opened_from_lot_id || Number(lot.loose_qty || 0) > 0
  ))
  const events = eventsQ.data || []

  const selectedPreview = useMemo(() => {
    if (!selectedLot) return null
    const packs = Math.floor(Number(packsToOpen || 0))
    const conversion = Number(selectedLot.conversion_qty || 0)
    return packs > 0 && conversion > 0 ? packs * conversion : 0
  }, [selectedLot, packsToOpen])

  const selectedClosePreview = useMemo(() => {
    if (!selectedCloseLot) return null
    const packs = Math.floor(Number(packsToClose || 0))
    const conversion = Number(selectedCloseLot.conversion_qty || 0)
    return packs > 0 && conversion > 0 ? packs * conversion : 0
  }, [selectedCloseLot, packsToClose])

  function maxClosable(lot?: InventoryLotBrowse | null) {
    const conversion = Number(lot?.conversion_qty || 0)
    if (!lot?.opened_from_lot_id || conversion <= 0) return 0
    return Math.floor(Number(lot.loose_qty || 0) / conversion)
  }

  function submitOpen() {
    if (!selectedLot) return
    const packs = Math.floor(Number(packsToOpen || 0))
    if (!Number.isFinite(packs) || packs <= 0) {
      toast.push(`Enter a valid ${parentUnit(selectedLot)} count`, 'error')
      return
    }
    if (packs > Number(selectedLot.sealed_qty || 0)) {
      toast.push(`Only ${selectedLot.sealed_qty} ${parentUnit(selectedLot)} available to open.`, 'error')
      return
    }
    openM.mutate({
      lot_id: Number(selectedLot.id),
      packs_opened: packs,
      note: note.trim() || undefined,
    })
  }

  function submitClose() {
    if (!selectedCloseLot) return
    const packs = Math.floor(Number(packsToClose || 0))
    const available = maxClosable(selectedCloseLot)
    if (!Number.isFinite(packs) || packs <= 0) {
      toast.push(`Enter a valid ${parentUnit(selectedCloseLot)} count`, 'error')
      return
    }
    if (packs > available) {
      toast.push(`Only ${available} ${parentUnit(selectedCloseLot)} can be closed from loose stock.`, 'error')
      return
    }
    closeM.mutate({
      lot_id: Number(selectedCloseLot.id),
      packs_closed: packs,
      note: closeNote.trim() || undefined,
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
            onChange={(e) => {
              setQ(e.target.value)
              setProductIdFilter(undefined)
            }}
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
                <th>Units / Parent</th>
                <th>Units</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => {
                const closable = maxClosable(lot)
                return (
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
                          Open {parentUnit(lot)}
                        </Button>
                      ) : closable > 0 ? (
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={() => {
                            setSelectedCloseLot(lot)
                            setPacksToClose('1')
                            setCloseNote('')
                          }}
                        >
                          Close {parentUnit(lot)}
                        </Button>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                )
              })}
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
        <Typography variant="h6" sx={{ mb: 2 }}>Recent Pack Events</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Source Lot</th>
                <th>Loose Lot</th>
                <th>Parent Units</th>
                <th>Loose Units</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const isClose = event.packs_opened < 0 || event.loose_units_created < 0
                return (
                  <tr key={event.id}>
                    <td>{formatDate(event.created_at)}</td>
                    <td>{isClose ? 'Closed' : 'Opened'}</td>
                    <td>{event.source_lot_id}</td>
                    <td>{event.loose_lot_id}</td>
                    <td>{Math.abs(event.packs_opened)}</td>
                    <td>{Math.abs(event.loose_units_created)}</td>
                    <td>{event.note || '-'}</td>
                  </tr>
                )
              })}
              {events.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <Box p={2} color="text.secondary">No pack events yet.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={Boolean(selectedLot)} onClose={() => setSelectedLot(null)} fullWidth maxWidth="sm">
        <DialogTitle>Open {parentUnit(selectedLot)}</DialogTitle>
        <DialogContent dividers>
          {selectedLot && (
            <Stack gap={2} mt={1}>
              <Typography fontWeight={700}>
                {selectedLot.product_name}{selectedLot.brand ? ` | ${selectedLot.brand}` : ''}
              </Typography>
              <Typography color="text.secondary">
                Available sealed stock: {selectedLot.sealed_qty} {parentUnit(selectedLot)}
              </Typography>
              <Typography color="text.secondary">
                Conversion: 1 {parentUnit(selectedLot)} = {selectedLot.conversion_qty || 0} {childUnit(selectedLot)}
              </Typography>
              <TextField
                label={`How many ${parentUnit(selectedLot)} to open?`}
                type="number"
                value={packsToOpen}
                onChange={(e) => setPacksToOpen(e.target.value)}
                fullWidth
                inputProps={{ min: 1, max: Number(selectedLot.sealed_qty || 0), step: 1 }}
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
                Loose stock to create: <strong>{selectedPreview || 0}</strong> {childUnit(selectedLot)}
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedLot(null)}>Cancel</Button>
          <Button variant="contained" onClick={submitOpen} disabled={openM.isPending}>Open</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(selectedCloseLot)} onClose={() => setSelectedCloseLot(null)} fullWidth maxWidth="sm">
        <DialogTitle>Close {parentUnit(selectedCloseLot)}</DialogTitle>
        <DialogContent dividers>
          {selectedCloseLot && (
            <Stack gap={2} mt={1}>
              <Typography fontWeight={700}>
                {selectedCloseLot.product_name}{selectedCloseLot.brand ? ` | ${selectedCloseLot.brand}` : ''}
              </Typography>
              <Typography color="text.secondary">
                Available loose stock: {selectedCloseLot.loose_qty} {childUnit(selectedCloseLot)}
              </Typography>
              <Typography color="text.secondary">
                Conversion: {selectedCloseLot.conversion_qty || 0} {childUnit(selectedCloseLot)} = 1 {parentUnit(selectedCloseLot)}
              </Typography>
              <TextField
                label={`How many ${parentUnit(selectedCloseLot)} to close?`}
                type="number"
                value={packsToClose}
                onChange={(e) => setPacksToClose(e.target.value)}
                fullWidth
                inputProps={{ min: 1, max: maxClosable(selectedCloseLot), step: 1 }}
                helperText={
                  selectedClosePreview
                    ? `Uses ${selectedClosePreview} ${childUnit(selectedCloseLot)}. Maximum: ${maxClosable(selectedCloseLot)} ${parentUnit(selectedCloseLot)}.`
                    : `Maximum: ${maxClosable(selectedCloseLot)} ${parentUnit(selectedCloseLot)}.`
                }
              />
              <TextField
                label="Note"
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                fullWidth
                multiline
                minRows={2}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedCloseLot(null)}>Cancel</Button>
          <Button variant="contained" onClick={submitClose} disabled={closeM.isPending}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
