import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchParties } from '../../services/parties'
import { fetchPurchase, fetchPurchases } from '../../services/purchases'
import { fetchLots } from '../../services/lots'
import {
  cancelPurchaseReturn,
  createPurchaseReturn,
  fetchPurchaseReturnHistory,
  fetchPurchaseReturns,
  updatePurchaseReturn,
  type PurchaseReturnCreatePayload,
} from '../../services/purchaseReturns'
import type { AuditLog, InventoryLotBrowse, Party, Purchase, PurchaseReturn } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'
import { useUserSession } from '../../components/session/UserSessionProvider'

type LineDraft = { quantity: string; unitCost: string }
type LegacyLine = { lot: InventoryLotBrowse; quantity: string; unitCost: string; gstPercent: string }
type ReturnSnapshot = {
  purchase_return: {
    return_number: string
    return_date: string
    party_id: number
    taxable_amount: number
    gst_amount: number
    rounding_adjustment: number
    total_amount: number
    is_deleted: boolean
  }
  items: Array<{ product_name: string; quantity: number; unit_cost: number; gst_percent: number; taxable_amount: number; gst_amount: number; line_total: number }>
}

function historyDetails(entry: AuditLog): { before?: ReturnSnapshot; after?: ReturnSnapshot } {
  try {
    return entry.details_json ? JSON.parse(entry.details_json) : {}
  } catch {
    return {}
  }
}

function snapshotItems(snapshot?: ReturnSnapshot) {
  if (!snapshot?.items.length) return 'No item lines'
  return snapshot.items.map((item) => `${item.product_name} x ${item.quantity} @ ${money(item.unit_cost)}`).join(', ')
}

function todayYmd() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function money(value: number) {
  return Number(value || 0).toFixed(2)
}

function linkedUnitCost(purchase: Purchase, item: Purchase['items'][number]) {
  const subtotal = Number(purchase.subtotal_amount || 0)
  const factor = subtotal > 0 ? Math.max(0, subtotal - Number(purchase.discount_amount || 0)) / subtotal : 0
  return Number(item.effective_cost_price || 0) * factor
}

function errorMessage(error: unknown) {
  const detail = (error as any)?.response?.data?.detail
  return typeof detail === 'string' ? detail : 'Purchase return could not be saved'
}

export default function PurchaseReturnsPage() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const { hasMinRole } = useUserSession()
  const canManage = hasMinRole('MANAGER')
  const [supplier, setSupplier] = useState<Party | null>(null)
  const [sourceMode, setSourceMode] = useState<'invoice' | 'legacy'>('invoice')
  const [purchase, setPurchase] = useState<Purchase | null>(null)
  const [lotSearch, setLotSearch] = useState('')
  const [selectedLot, setSelectedLot] = useState<InventoryLotBrowse | null>(null)
  const [legacyLines, setLegacyLines] = useState<LegacyLine[]>([])
  const [returnDate, setReturnDate] = useState(todayYmd())
  const [returnNumber, setReturnNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [roundingAdjustment, setRoundingAdjustment] = useState('0')
  const [lines, setLines] = useState<Record<number, LineDraft>>({})
  const [cancelTarget, setCancelTarget] = useState<PurchaseReturn | null>(null)
  const [editingReturn, setEditingReturn] = useState<PurchaseReturn | null>(null)
  const [historyTarget, setHistoryTarget] = useState<PurchaseReturn | null>(null)

  const suppliersQ = useQuery({
    queryKey: ['purchase-return-suppliers'],
    queryFn: () => fetchParties({ party_group: 'SUNDRY_CREDITOR', is_active: true }),
  })
  const purchasesQ = useQuery({
    queryKey: ['purchase-return-purchases', supplier?.id],
    queryFn: () => fetchPurchases({ party_id: Number(supplier?.id), limit: 500 }),
    enabled: Boolean(supplier?.id),
  })
  const returnsQ = useQuery({
    queryKey: ['purchase-returns'],
    queryFn: () => fetchPurchaseReturns({ include_deleted: true, limit: 1000 }),
  })
  const lotsQ = useQuery({
    queryKey: ['purchase-return-legacy-lots', lotSearch.trim()],
    queryFn: () => fetchLots({ q: lotSearch.trim() || undefined }),
    enabled: sourceMode === 'legacy',
  })
  const historyQ = useQuery({
    queryKey: ['purchase-return-history', historyTarget?.id],
    queryFn: () => fetchPurchaseReturnHistory(Number(historyTarget?.id)),
    enabled: Boolean(historyTarget?.id),
  })

  const activeReturnedByItem = useMemo(() => {
    const totals = new Map<number, number>()
    for (const row of returnsQ.data || []) {
      if (row.is_deleted) continue
      for (const item of row.items) {
        totals.set(Number(item.purchase_item_id), (totals.get(Number(item.purchase_item_id)) || 0) + Number(item.quantity || 0))
      }
    }
    return totals
  }, [returnsQ.data])

  useEffect(() => {
    if (!purchase) {
      setLines({})
      return
    }
    setLines(Object.fromEntries(purchase.items.map((item) => {
      const existing = editingReturn?.items.find((returned) => Number(returned.purchase_item_id) === Number(item.id))
      return [Number(item.id), {
        quantity: existing ? String(existing.quantity) : '0',
        unitCost: String(Number(existing?.unit_cost ?? linkedUnitCost(purchase, item)).toFixed(2)),
      }]
    })))
    setReturnDate((current) => current < purchase.invoice_date ? purchase.invoice_date : current)
  }, [editingReturn, purchase])

  const selectedLines = useMemo(() => (purchase?.items || []).flatMap((item) => {
    const draft = lines[Number(item.id)]
    const quantity = Number(draft?.quantity || 0)
    const unitCost = Number(draft?.unitCost || 0)
    return quantity > 0 ? [{ purchase_item_id: Number(item.id), quantity, unit_cost: unitCost, gst_percent: Number(item.gst_percent || 0) }] : []
  }), [purchase, lines])
  const selectedLegacyLines = useMemo(() => legacyLines.flatMap((line) => {
    const quantity = Number(line.quantity || 0)
    const unitCost = Number(line.unitCost || 0)
    return quantity > 0 ? [{
      inventory_item_id: Number(line.lot.legacy_item_id),
      lot_id: Number(line.lot.id),
      quantity,
      unit_cost: unitCost,
      gst_percent: Number(line.gstPercent || 0),
    }] : []
  }), [legacyLines])
  const activeLines = sourceMode === 'invoice' ? selectedLines : selectedLegacyLines
  const returnSubtotal = useMemo(
    () => activeLines.reduce((sum, item) => {
      const taxable = item.quantity * Number(item.unit_cost || 0)
      return sum + taxable + taxable * Number(item.gst_percent || 0) / 100
    }, 0),
    [activeLines],
  )
  const returnTotal = returnSubtotal + Number(roundingAdjustment || 0)

  const saveM = useMutation({
    mutationFn: ({ payload, id }: { payload: PurchaseReturnCreatePayload; id?: number }) => (
      id ? updatePurchaseReturn(id, payload) : createPurchaseReturn(payload)
    ),
    onSuccess: async (saved) => {
      toast.push(`Purchase return ${saved.return_number} ${editingReturn ? 'updated' : 'created'}`)
      setPurchase(null)
      setLegacyLines([])
      setSelectedLot(null)
      setEditingReturn(null)
      setReturnNumber('')
      setNotes('')
      setRoundingAdjustment('0')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['purchase-returns'] }),
        queryClient.invalidateQueries({ queryKey: ['purchases-list'] }),
        queryClient.invalidateQueries({ queryKey: ['purchase-return-purchases'] }),
        queryClient.invalidateQueries({ queryKey: ['supplier-ledger'] }),
        queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['voucher-day-book'] }),
      ])
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  })

  const cancelM = useMutation({
    mutationFn: (id: number) => cancelPurchaseReturn(id),
    onSuccess: async () => {
      toast.push('Purchase return cancelled')
      setCancelTarget(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['purchase-returns'] }),
        queryClient.invalidateQueries({ queryKey: ['purchases-list'] }),
        queryClient.invalidateQueries({ queryKey: ['purchase-return-purchases'] }),
        queryClient.invalidateQueries({ queryKey: ['supplier-ledger'] }),
        queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['voucher-day-book'] }),
      ])
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  })

  function submit() {
    if (!supplier) {
      toast.push('Select a supplier', 'warning')
      return
    }
    if ((sourceMode === 'invoice' && !purchase) || activeLines.length === 0) {
      toast.push('Enter a return quantity for at least one item', 'warning')
      return
    }
    if (returnTotal < 0) {
      toast.push('Credit total cannot be negative after round off', 'warning')
      return
    }
    saveM.mutate({
      id: editingReturn ? Number(editingReturn.id) : undefined,
      payload: {
      purchase_id: sourceMode === 'invoice' ? Number(purchase?.id) : undefined,
      party_id: sourceMode === 'legacy' ? Number(supplier.id) : undefined,
      return_date: returnDate,
      return_number: returnNumber.trim() || undefined,
      notes: notes.trim() || undefined,
      rounding_adjustment: Number(roundingAdjustment || 0),
      items: activeLines,
      },
    })
  }

  async function beginEdit(row: PurchaseReturn) {
    const selectedSupplier = (suppliersQ.data || []).find((item) => Number(item.id) === Number(row.party_id)) || null
    setSupplier(selectedSupplier)
    setReturnDate(row.return_date)
    setReturnNumber(row.return_number)
    setNotes(row.notes || '')
    setRoundingAdjustment(String(row.rounding_adjustment || 0))
    setEditingReturn(row)
    if (row.purchase_id) {
      setSourceMode('invoice')
      const sourcePurchase = await fetchPurchase(Number(row.purchase_id))
      setPurchase(sourcePurchase)
      setLegacyLines([])
    } else {
      setSourceMode('legacy')
      setPurchase(null)
      const productIds = [...new Set(row.items.map((item) => Number(item.product_id)))]
      const lotGroups = await Promise.all(productIds.map((productId) => fetchLots({ product_id: productId })))
      const lots = lotGroups.flat()
      setLegacyLines(row.items.map((item) => {
        const lot = lots.find((candidate) => Number(candidate.id) === Number(item.lot_id))
        return {
          lot: lot || {
            id: Number(item.lot_id),
            product_id: Number(item.product_id),
            product_name: item.product_name,
            mrp: 0,
            cost_price: item.unit_cost,
            rack_number: 0,
            sealed_qty: item.quantity,
            loose_qty: 0,
            loose_sale_enabled: false,
            legacy_item_id: Number(item.inventory_item_id),
            is_active: true,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
          quantity: String(item.quantity),
          unitCost: String(item.unit_cost),
          gstPercent: String(item.gst_percent || 0),
        }
      }))
    }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function stopEditing() {
    setEditingReturn(null)
    setPurchase(null)
    setLegacyLines([])
    setSelectedLot(null)
    setReturnNumber('')
    setNotes('')
    setRoundingAdjustment('0')
  }

  function addLegacyLot() {
    if (!selectedLot?.legacy_item_id || selectedLot.opened_from_lot_id) {
      toast.push('Select a sealed inventory batch', 'warning')
      return
    }
    if (legacyLines.some((line) => Number(line.lot.id) === Number(selectedLot.id))) {
      toast.push('That batch is already included', 'warning')
      return
    }
    setLegacyLines((current) => [...current, {
      lot: selectedLot,
      quantity: '1',
      unitCost: String(Number(selectedLot.cost_price || 0).toFixed(2)),
      gstPercent: '0',
    }])
    setSelectedLot(null)
    setLotSearch('')
  }

  return (
    <Box sx={{ p: { xs: 1.5, md: 3 } }}>
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h4" fontWeight={800}>Purchase Returns</Typography>
          <Typography color="text.secondary">Return stock to its original supplier and batch, with a supplier credit note.</Typography>
        </Box>

        {!canManage && <Alert severity="info">Manager or owner access is required to create or cancel purchase returns.</Alert>}

        <Paper sx={{ p: 2.5 }}>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6" fontWeight={700}>{editingReturn ? `Edit ${editingReturn.return_number}` : 'New Purchase Return'}</Typography>
              {editingReturn && <Button onClick={stopEditing}>Discard Edit</Button>}
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button
                variant={sourceMode === 'invoice' ? 'contained' : 'outlined'}
                disabled={Boolean(editingReturn)}
                onClick={() => { setSourceMode('invoice'); setLegacyLines([]) }}
              >
                Linked Purchase Invoice
              </Button>
              <Button
                variant={sourceMode === 'legacy' ? 'contained' : 'outlined'}
                disabled={Boolean(editingReturn)}
                onClick={() => { setSourceMode('legacy'); setPurchase(null); setLines({}) }}
              >
                No Invoice / Legacy Stock
              </Button>
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <Autocomplete
                sx={{ minWidth: 280, flex: 1 }}
                options={suppliersQ.data || []}
                value={supplier}
                disabled={Boolean(editingReturn?.purchase_id)}
                getOptionLabel={(option) => option.name}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                onChange={(_event, value) => { setSupplier(value); setPurchase(null) }}
                renderInput={(params) => <TextField {...params} label="Supplier" />}
              />
              {sourceMode === 'invoice' && <Autocomplete
                sx={{ minWidth: 320, flex: 1.4 }}
                options={(purchasesQ.data || []).filter((row) => !row.is_deleted)}
                value={purchase}
                disabled={!supplier || Boolean(editingReturn)}
                getOptionLabel={(option) => `${option.invoice_number} | ${option.invoice_date} | ${money(option.net_amount ?? option.total_amount)}`}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                onChange={(_event, value) => setPurchase(value)}
                renderInput={(params) => <TextField {...params} label="Source purchase invoice" />}
              />}
              <TextField label="Return date" type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} InputLabelProps={{ shrink: true }} />
            </Stack>

            {(purchase || sourceMode === 'legacy') && (
              <>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                  <TextField label="Supplier credit note / return no." value={returnNumber} onChange={(event) => setReturnNumber(event.target.value)} helperText="Optional; generated automatically when blank" sx={{ flex: 1 }} />
                  <TextField label="Notes / reason" value={notes} onChange={(event) => setNotes(event.target.value)} sx={{ flex: 2 }} />
                </Stack>
                <Divider />
                {sourceMode === 'legacy' && (
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
                    <Autocomplete
                      sx={{ flex: 1 }}
                      options={(lotsQ.data || []).filter((lot) => Boolean(lot.legacy_item_id) && !lot.opened_from_lot_id && Number(lot.sealed_qty || 0) > 0)}
                      value={selectedLot}
                      inputValue={lotSearch}
                      onInputChange={(_event, value) => setLotSearch(value)}
                      onChange={(_event, value) => setSelectedLot(value)}
                      getOptionLabel={(lot) => `${lot.product_name} | ${lot.brand || 'No brand'} | Exp ${lot.expiry_date || '-'} | Stock ${lot.sealed_qty} | MRP ${money(lot.mrp)}`}
                      isOptionEqualToValue={(option, value) => option.id === value.id}
                      renderInput={(params) => <TextField {...params} label="Search exact inventory batch" helperText="Only sealed stock with a linked inventory item is shown" />}
                    />
                    <Button variant="outlined" disabled={!selectedLot} onClick={addLegacyLot}>Add Batch</Button>
                  </Stack>
                )}
                <Stack spacing={1.25}>
                  {sourceMode === 'invoice' && purchase?.items.map((item) => {
                    const purchased = Number(item.sealed_qty || 0) + Number(item.free_qty || 0)
                    const alreadyReturned = activeReturnedByItem.get(Number(item.id)) || 0
                    const remaining = Math.max(0, purchased - alreadyReturned)
                    const draft = lines[Number(item.id)] || { quantity: '0', unitCost: String(linkedUnitCost(purchase, item)) }
                    return (
                      <Paper key={item.id} variant="outlined" sx={{ p: 1.5 }}>
                        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
                          <Box sx={{ flex: 1 }}>
                            <Typography fontWeight={700}>{item.product_name}</Typography>
                            <Typography variant="body2" color="text.secondary">
                              {item.brand || 'No brand'} | Exp {item.expiry_date || '-'} | Purchased {purchased} | Previously returned {alreadyReturned} | Max {remaining}
                            </Typography>
                          </Box>
                          <TextField
                            label="Return qty"
                            type="number"
                            value={draft.quantity}
                            inputProps={{ min: 0, max: remaining, step: 1 }}
                            onChange={(event) => setLines((current) => ({ ...current, [Number(item.id)]: { ...draft, quantity: event.target.value } }))}
                            sx={{ width: 130 }}
                          />
                          <TextField
                            label="Credit rate"
                            type="number"
                            value={draft.unitCost}
                            inputProps={{ min: 0, step: 0.01 }}
                            onChange={(event) => setLines((current) => ({ ...current, [Number(item.id)]: { ...draft, unitCost: event.target.value } }))}
                            sx={{ width: 145 }}
                          />
                        <Typography sx={{ minWidth: 110, textAlign: 'right' }} fontWeight={700}>
                            {money(Number(draft.quantity || 0) * Number(draft.unitCost || 0) * (1 + Number(item.gst_percent || 0) / 100))}
                        </Typography>
                        <Chip size="small" label={`GST ${money(item.gst_percent)}%`} variant="outlined" />
                        </Stack>
                      </Paper>
                    )
                  })}
                  {sourceMode === 'legacy' && legacyLines.map((line) => (
                    <Paper key={String(line.lot.id)} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
                        <Box sx={{ flex: 1 }}>
                          <Typography fontWeight={700}>{line.lot.product_name}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            {line.lot.brand || 'No brand'} | Exp {line.lot.expiry_date || '-'} | Rack {line.lot.rack_number} | MRP {money(line.lot.mrp)} | Available {line.lot.sealed_qty}
                          </Typography>
                        </Box>
                        <TextField
                          label="Return qty"
                          type="number"
                          value={line.quantity}
                          inputProps={{ min: 0, max: line.lot.sealed_qty, step: 1 }}
                          onChange={(event) => setLegacyLines((current) => current.map((entry) => entry.lot.id === line.lot.id ? { ...entry, quantity: event.target.value } : entry))}
                          sx={{ width: 130 }}
                        />
                        <TextField
                          label="Credit rate"
                          type="number"
                          value={line.unitCost}
                          inputProps={{ min: 0, step: 0.01 }}
                          onChange={(event) => setLegacyLines((current) => current.map((entry) => entry.lot.id === line.lot.id ? { ...entry, unitCost: event.target.value } : entry))}
                          sx={{ width: 145 }}
                        />
                        <TextField
                          label="GST %"
                          type="number"
                          value={line.gstPercent}
                          inputProps={{ min: 0, max: 100, step: 0.01 }}
                          onChange={(event) => setLegacyLines((current) => current.map((entry) => entry.lot.id === line.lot.id ? { ...entry, gstPercent: event.target.value } : entry))}
                          sx={{ width: 110 }}
                        />
                        <Typography sx={{ minWidth: 110, textAlign: 'right' }} fontWeight={700}>
                          {money(Number(line.quantity || 0) * Number(line.unitCost || 0) * (1 + Number(line.gstPercent || 0) / 100))}
                        </Typography>
                        <Button color="error" onClick={() => setLegacyLines((current) => current.filter((entry) => entry.lot.id !== line.lot.id))}>Remove</Button>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="flex-end" alignItems={{ sm: 'center' }} spacing={2}>
                  <Typography>Taxable + GST: {money(returnSubtotal)}</Typography>
                  <TextField
                    label="Round Off (+/-)"
                    type="number"
                    value={roundingAdjustment}
                    inputProps={{ step: 0.01 }}
                    onChange={(event) => setRoundingAdjustment(event.target.value)}
                    sx={{ width: 160 }}
                  />
                  <Typography variant="h6">Credit total: {money(returnTotal)}</Typography>
                  <Button variant="contained" disabled={!canManage || saveM.isPending || activeLines.length === 0} onClick={submit}>
                    {editingReturn ? 'Save Return Changes' : 'Create Purchase Return'}
                  </Button>
                </Stack>
              </>
            )}
          </Stack>
        </Paper>

        <Paper sx={{ p: 2.5 }}>
          <Typography variant="h6" fontWeight={700} mb={2}>Return History</Typography>
          <Stack spacing={1.25}>
            {(returnsQ.data || []).map((row) => {
              const supplierName = (suppliersQ.data || []).find((item) => Number(item.id) === Number(row.party_id))?.name
              return (
                <Paper key={row.id} variant="outlined" sx={{ p: 1.5, opacity: row.is_deleted ? 0.65 : 1 }}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
                    <Box sx={{ flex: 1 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography fontWeight={800}>{row.return_number}</Typography>
                        <Chip size="small" color={row.is_deleted ? 'default' : 'secondary'} label={row.is_deleted ? 'Cancelled' : 'Posted'} />
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        {row.return_date} | {supplierName || `Supplier #${row.party_id}`} | {row.purchase_id ? `Purchase #${row.purchase_id}` : 'No purchase invoice'}
                      </Typography>
                      <Typography variant="body2">{row.items.map((item) => `${item.product_name} x ${item.quantity}`).join(', ')}</Typography>
                    </Box>
                    <Box sx={{ textAlign: { md: 'right' } }}>
                      <Typography variant="h6">{money(row.total_amount)}</Typography>
                      <Typography variant="caption" color="text.secondary">GST {money(row.gst_amount)} | Round off {money(row.rounding_adjustment)}</Typography>
                    </Box>
                    <Stack direction="row" spacing={1}>
                      <Button variant="text" onClick={() => setHistoryTarget(row)}>History</Button>
                      {!row.is_deleted && canManage && (
                        <>
                        <Button variant="outlined" onClick={() => beginEdit(row)}>Edit</Button>
                        <Button color="error" variant="outlined" onClick={() => setCancelTarget(row)}>Cancel</Button>
                        </>
                      )}
                    </Stack>
                  </Stack>
                </Paper>
              )
            })}
            {!returnsQ.isLoading && (returnsQ.data || []).length === 0 && <Typography color="text.secondary">No purchase returns recorded.</Typography>}
          </Stack>
        </Paper>
      </Stack>

      <Dialog open={Boolean(cancelTarget)} onClose={() => !cancelM.isPending && setCancelTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Cancel Purchase Return?</DialogTitle>
        <DialogContent dividers>
          <Typography>This restores all stock and reverses supplier credit note {cancelTarget?.return_number}.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelTarget(null)} disabled={cancelM.isPending}>Keep Return</Button>
          <Button color="error" variant="contained" disabled={cancelM.isPending} onClick={() => cancelTarget && cancelM.mutate(Number(cancelTarget.id))}>Cancel Return</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(historyTarget)} onClose={() => setHistoryTarget(null)} maxWidth="md" fullWidth>
        <DialogTitle>History: {historyTarget?.return_number}</DialogTitle>
        <DialogContent dividers>
          {historyQ.isLoading && <Typography color="text.secondary">Loading history...</Typography>}
          {historyQ.isError && <Alert severity="error">Return history could not be loaded.</Alert>}
          <Stack spacing={1.5}>
            {(historyQ.data || []).map((entry) => {
              const details = historyDetails(entry)
              const before = details.before
              const after = details.after
              return (
                <Paper key={entry.id} variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={0.5}>
                    <Typography fontWeight={800}>{entry.action}</Typography>
                    <Typography variant="body2" color="text.secondary">{entry.event_ts}{entry.actor ? ` | ${entry.actor}` : ''}</Typography>
                  </Stack>
                  {entry.note && <Typography variant="body2" mb={1}>{entry.note}</Typography>}
                  {before && (
                    <Box sx={{ mb: 1 }}>
                      <Typography variant="caption" color="text.secondary">BEFORE</Typography>
                      <Typography variant="body2">
                        {before.purchase_return.return_date} | {before.purchase_return.is_deleted ? 'Cancelled' : 'Posted'} | GST {money(before.purchase_return.gst_amount)} | Round off {money(before.purchase_return.rounding_adjustment)} | {money(before.purchase_return.total_amount)}
                      </Typography>
                      <Typography variant="body2">{snapshotItems(before)}</Typography>
                    </Box>
                  )}
                  {after && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">AFTER</Typography>
                      <Typography variant="body2">
                        {after.purchase_return.return_date} | {after.purchase_return.is_deleted ? 'Cancelled' : 'Posted'} | GST {money(after.purchase_return.gst_amount)} | Round off {money(after.purchase_return.rounding_adjustment)} | {money(after.purchase_return.total_amount)}
                      </Typography>
                      <Typography variant="body2">{snapshotItems(after)}</Typography>
                    </Box>
                  )}
                </Paper>
              )
            })}
            {!historyQ.isLoading && !historyQ.isError && (historyQ.data || []).length === 0 && (
              <Typography color="text.secondary">No audit events recorded.</Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setHistoryTarget(null)}>Close</Button></DialogActions>
      </Dialog>
    </Box>
  )
}
