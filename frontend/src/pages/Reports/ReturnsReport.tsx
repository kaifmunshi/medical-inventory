import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  Divider,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { listReturns, getReturn, getExchangeByReturn, getReturnHistory, updateReturnRefundMode } from '../../services/returns'
import { getBill } from '../../services/billing'
import { useToast } from '../../components/ui/Toaster'
import { useUserSession } from '../../components/session/UserSessionProvider'

function toCSV(rows: string[][]) {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell ?? '')
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(',')
    )
    .join('\n')
}

function itemsPreview(items: any[], max = 6) {
  const names = (items || []).map((it: any) => itemDisplayName(it))
  if (names.length <= max) return names.join(', ') || '—'
  const head = names.slice(0, max).join(', ')
  return `${head} +${names.length - max} more`
}

function money(n: number | string | undefined | null) {
  const v = Number(n || 0)
  return v.toFixed(2)
}

function formatDateTime(v: any) {
  const s = String(v || '').trim()
  return s || '-'
}

function formatExpiry(v: any) {
  const s = String(v || '').trim()
  return s ? s.slice(0, 10) : '-'
}

function itemKindLabel(it: any) {
  return it?.is_loose_stock ? 'Loose' : 'Pack'
}

function itemUnitLabel(it: any) {
  return String(
    it?.stock_unit_label ||
    (it?.is_loose_stock ? it?.child_unit_name : it?.parent_unit_name) ||
    (it?.is_loose_stock ? 'Unit' : 'Pack')
  )
}

function itemMetaLine(it: any) {
  return [it?.brand, itemKindLabel(it), itemUnitLabel(it)].filter(Boolean).join(' | ')
}

function itemDisplayName(it: any) {
  const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
  return `${name}${it?.brand ? ` | ${it.brand}` : ''} - ${itemKindLabel(it)}`
}

function inferReturnRefundMode(row: any) {
  const explicit = String(row?.refund_mode || '').trim().toLowerCase()
  if (explicit) return explicit
  const cash = Number(row?.refund_cash || 0)
  const online = Number(row?.refund_online || 0)
  if (cash > 0 && online > 0) return 'split'
  if (cash > 0) return 'cash'
  if (online > 0) return 'online'
  return 'credit'
}

function soldUnitPrice(it: any) {
  const qty = Number(it?.quantity || 0)
  const line = Number(it?.line_total || 0)
  if (qty > 0 && line > 0) return line / qty
  return Number(it?.mrp || 0)
}

function discountPerUnit(it: any) {
  return Math.max(0, Number(it?.mrp || 0) - soldUnitPrice(it))
}

function billSoldUnitPrice(bill: any, it: any) {
  const source = (bill?.items || []).find((item: any) => Number(item?.item_id) === Number(it?.item_id))
  const qty = Number(source?.quantity || 0)
  const lineTotal = Number(source?.line_total || 0)
  if (qty > 0 && lineTotal > 0) return lineTotal / qty
  return soldUnitPrice(it)
}

function billDiscountPerUnit(bill: any, it: any) {
  return Math.max(0, Number(it?.mrp || 0) - billSoldUnitPrice(bill, it))
}

function actualRefundTotal(row: any) {
  const cashOnline = Number(row?.refund_cash || 0) + Number(row?.refund_online || 0)
  if (cashOnline > 0) return cashOnline
  return Number(row?.subtotal_return || 0)
}

function auditPaymentSummary(detailsJson?: string | null) {
  try {
    const details = JSON.parse(String(detailsJson || '{}'))
    const before = details?.before
    const after = details?.after
    if (!before || !after) return null
    const summary = (value: any) => `${String(value?.refund_mode || '-').toUpperCase()} | Cash ₹${money(value?.refund_cash)} | Online ₹${money(value?.refund_online)}`
    return `${summary(before)} → ${summary(after)}`
  } catch {
    return null
  }
}

function adjustedLineRefund(row: any, items: any[], it: any, salePrice: number) {
  const qty = Number(it?.quantity || 0)
  const lineValue = qty * salePrice
  const actualTotal = actualRefundTotal(row)
  const computedTotal = (items || []).reduce((sum: number, item: any) => {
    const unit = row?.source_bill ? billSoldUnitPrice(row.source_bill, item) : soldUnitPrice(item)
    return sum + Number(item?.quantity || 0) * unit
  }, 0)
  if (actualTotal > 0 && computedTotal > 0) return lineValue * (actualTotal / computedTotal)
  return lineValue
}

export default function ReturnsReport(props: {
  from: string
  to: string
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
}) {
  const { from, to, setExportFn, setExportDisabled } = props
  const toast = useToast()
  const queryClient = useQueryClient()
  const { hasMinRole } = useUserSession()
  const canEditPayment = hasMinRole('MANAGER')

  // dialog
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<any | null>(null)
  const [billDetail, setBillDetail] = useState<any | null>(null)
  const [billReturnItems, setBillReturnItems] = useState<any[]>([])
  const [billOpen, setBillOpen] = useState(false)
  const [paymentEditOpen, setPaymentEditOpen] = useState(false)
  const [editMode, setEditMode] = useState<'cash' | 'online' | 'split' | 'credit'>('cash')
  const [editCash, setEditCash] = useState('0')
  const [editOnline, setEditOnline] = useState('0')

  const qRets = useInfiniteQuery({
    queryKey: ['rpt-returns', from, to],
    enabled: true,
    initialPageParam: 0,
    queryFn: async () => {
      return await listReturns({ from_date: from, to_date: to, limit: 500 })
    },
    getNextPageParam: () => undefined,
  })

  const historyQ = useQuery({
    queryKey: ['sales-return-history', detail?.id],
    queryFn: () => getReturnHistory(Number(detail?.id)),
    enabled: open && detail?.kind === 'return' && Number(detail?.id) > 0,
  })

  const returnsRaw = useMemo(() => {
    const pages: any[] = ((qRets.data as any)?.pages ?? []) as any[]
    const all: any[] = []
    for (const p of pages) if (Array.isArray(p)) all.push(...p)
    return all
  }, [qRets.data])

  const detailRows = useMemo(() => {
    const rets = (returnsRaw || []) as any[]
    return rets.map((r) => {
      const refundCalc = (r.items || []).reduce(
        (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
        0
      )
      const refund = r.subtotal_return ?? refundCalc
      return {
        raw: r,
        id: r.id,
        date: r.date_time || r.created_at || '',
        linesCount: (r.items || []).length,
        itemsPreview: itemsPreview(r.items || []),
        refund: money(refund),
        refundMode: inferReturnRefundMode(r),
        notes: r.notes || '',
      }
    })
  }, [returnsRaw])

  async function openDetail(row: any) {
    try {
      const ex = await getExchangeByReturn(row.id)
      let sourceBill: any = null
      if (ex.source_bill_id) {
        try {
          sourceBill = await getBill(Number(ex.source_bill_id))
        } catch {}
      }
      setDetail({ kind: 'exchange', source_bill: sourceBill, ...ex })
      setOpen(true)
      return
    } catch {}

    let r = row.raw
    if (!r?.items || !Array.isArray(r.items) || r.items.length === 0) {
      try {
        r = await getReturn(row.id)
      } catch {}
    }
    let sourceBill: any = null
    if (r?.source_bill_id) {
      try {
        sourceBill = await getBill(Number(r.source_bill_id))
      } catch {}
    }
    setDetail({ kind: 'return', source_bill: sourceBill, ...r })
    setOpen(true)
  }

  async function openBillDetail(billId: any, returnItems: any[] = []) {
    const id = Number(billId || 0)
    if (!id) return
    try {
      const bill = await getBill(id)
      setBillDetail(bill)
      setBillReturnItems(returnItems || [])
      setBillOpen(true)
    } catch (err: any) {
      toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to load bill'), 'error')
    }
  }

  function returnedQtyForItem(item: any) {
    return (billReturnItems || [])
      .filter((ret) => Number(ret?.item_id || 0) === Number(item?.item_id || 0))
      .reduce((sum, ret) => sum + Number(ret?.quantity || 0), 0)
  }

  function openPaymentEditor() {
    if (!detail || detail.kind !== 'return') return
    const mode = inferReturnRefundMode(detail) as 'cash' | 'online' | 'split' | 'credit'
    const returnValue = Number(detail.subtotal_return || 0)
    setEditMode(mode)
    setEditCash(String(mode === 'cash' ? Number(detail.refund_cash || returnValue) : Number(detail.refund_cash || 0)))
    setEditOnline(String(mode === 'online' ? Number(detail.refund_online || returnValue) : Number(detail.refund_online || 0)))
    setPaymentEditOpen(true)
  }

  const mUpdatePayment = useMutation({
    mutationFn: async () => {
      if (!detail?.id) throw new Error('Sales return is not loaded')
      return updateReturnRefundMode(Number(detail.id), {
        refund_mode: editMode,
        refund_cash: editMode === 'cash' || editMode === 'split' ? Number(editCash || 0) : 0,
        refund_online: editMode === 'online' || editMode === 'split' ? Number(editOnline || 0) : 0,
      })
    },
    onSuccess: async (updated) => {
      setDetail((current: any) => ({ ...current, ...updated, kind: 'return' }))
      setPaymentEditOpen(false)
      await qRets.refetch()
      await historyQ.refetch()
      queryClient.invalidateQueries()
      toast.push('Sales return customer payment updated', 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update customer payment'), 'error')
    },
  })

  // export
  useEffect(() => {
    setExportDisabled(detailRows.length === 0)
    setExportFn(() => () => {
      const header = ['Sales Return ID', 'Date/Time', 'Lines', 'Refund', 'Refund Mode', 'Notes']
      const body = detailRows.map((r: any) => [r.id, r.date, r.linesCount, r.refund, r.refundMode, r.notes])

      const csv = toCSV([header, ...body])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sales-returns-report_${from}_to_${to}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
  }, [setExportDisabled, setExportFn, detailRows, from, to])

  return (
    <>
      <Box sx={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Sales Return ID</th>
              <th>Date/Time</th>
              <th>Lines</th>
              <th>Refund</th>
              <th>Refund Mode</th>
              <th>Notes</th>
            </tr>
          </thead>

          <tbody>
            {detailRows.map((r: any) => (
              <tr key={`r-${r.id}`}>
                <td>
                  <Tooltip title={r.itemsPreview} arrow placement="top">
                    <Link component="button" onClick={() => openDetail(r)} underline="hover">
                      {r.id}
                    </Link>
                  </Tooltip>
                </td>
                <td>{r.date}</td>
                <td>{r.linesCount}</td>
                <td>{r.refund}</td>
                <td>{String(r.refundMode || '').toUpperCase()}</td>
                <td>{r.notes}</td>
              </tr>
            ))}

            {detailRows.length === 0 && !qRets.isLoading && (
              <tr>
                <td colSpan={6}>
                  <Box p={2} color="text.secondary">
                    No data.
                  </Box>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Box>

      {qRets.isLoading && (
        <Box sx={{ py: 2, textAlign: 'center' }}>
          <Typography variant="body2">Loading…</Typography>
        </Box>
      )}

      {qRets.isError && (
        <Box sx={{ py: 2, textAlign: 'center' }}>
          <Typography variant="body2" color="error">
            Failed to load.
          </Typography>
        </Box>
      )}

      {/* Return detail dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {detail?.kind === 'exchange' ? 'Exchange Details' : 'Sales Return Details'}
          <IconButton onClick={() => setOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers>
          {!detail ? (
            <Typography color="text.secondary">Loading…</Typography>
          ) : detail.kind === 'exchange' ? (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  Sales Return ID: <b>{detail.return_id}</b>
                  {' '}| Source Bill:{' '}
                  {detail.source_bill_id ? (
                    <Link component="button" underline="hover" onClick={() => openBillDetail(detail.source_bill_id, detail.return?.items || [])}>
                      #{detail.source_bill_id}
                    </Link>
                  ) : (
                    <b>-</b>
                  )}
                  {' '}| New Bill:{' '}
                  <Link component="button" underline="hover" onClick={() => openBillDetail(detail.new_bill_id)}>
                    #{detail.new_bill_id}
                  </Link>
                </Typography>
                <Stack gap={0.25} alignItems={{ md: 'flex-end' }}>
                  <Typography variant="subtitle1">
                    Return Date: <b>{formatDateTime(detail.return?.date_time || detail.created_at)}</b>
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Bill Date: <b>{formatDateTime(detail.source_bill?.date_time)}</b>
                  </Typography>
                </Stack>
              </Stack>

              <Divider />

              <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
                <Stack gap={0.5}>
                  <Typography variant="subtitle2">Exchange Summary</Typography>
                  <Typography>Theoretical Net: <b>₹{money(detail.theoretical_net)}</b></Typography>
                  <Typography>Rounding Adj: <b>₹{money(detail.rounding_adjustment)}</b></Typography>
                  <Typography>Final Net Due: <b>₹{money(detail.net_due)}</b></Typography>
                  <Typography>
                    Payment: <b>{String(detail.payment_mode || '').toUpperCase() || '-'}</b>
                    {' '}| Cash ₹{money(detail.payment_cash)} | Online ₹{money(detail.payment_online)}
                  </Typography>
                  <Typography>
                    Refund: Cash ₹{money(detail.refund_cash)} | Online ₹{money(detail.refund_online)}
                  </Typography>
                </Stack>
              </Stack>

              <Divider />

              <Typography variant="subtitle2">Returned Items</Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>Sale Price</th>
                      <th>Discount</th>
                      <th>Line Refund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.return?.items || []).map((it: any, idx: number) => {
                      const refundContext = {
                        ...(detail.return || {}),
                        source_bill: detail.source_bill,
                        refund_cash: detail.refund_cash,
                        refund_online: detail.refund_online,
                      }
                      const sale = detail.source_bill ? billSoldUnitPrice(detail.source_bill, it) : soldUnitPrice(it)
                      const discount = detail.source_bill ? billDiscountPerUnit(detail.source_bill, it) : discountPerUnit(it)
                      const lineRefund = adjustedLineRefund(refundContext, detail.return?.items || [], it, sale)
                      return (
                        <tr key={`ret-${idx}`}>
                          <td>
                            <Stack gap={0.25}>
                              <Typography variant="body2">{it.item_name || `#${it.item_id}`}</Typography>
                              <Typography variant="caption" color="text.secondary">
                                {itemMetaLine(it)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                Batch #{it.batch_number || it.item_id || '-'} | Exp {formatExpiry(it.expiry_date)}
                              </Typography>
                            </Stack>
                          </td>
                          <td>{Number(it.quantity || 0)} {itemUnitLabel(it)}</td>
                          <td>₹{money(it.mrp)}</td>
                          <td>₹{money(sale)}</td>
                          <td>{discount > 0 ? `₹${money(discount)}` : '-'}</td>
                          <td>₹{money(lineRefund)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Box>

              <Typography variant="subtitle2">New Bill Items</Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>SP</th>
                      <th>Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.bill?.items || []).map((it: any, idx: number) => {
                      const qty = Number(it.quantity || 0)
                      const lineTotal = Number(it.line_total ?? qty * Number(it.mrp || 0))
                      return <tr key={`bill-${idx}`}>
                        <td>
                          <Stack gap={0.25}>
                            <Typography variant="body2">{it.item_name || `#${it.item_id}`}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {itemMetaLine(it)}
                            </Typography>
                          </Stack>
                        </td>
                        <td>{qty} {itemUnitLabel(it)}</td>
                        <td>{money(it.mrp)}</td>
                        <td>{money(qty > 0 ? lineTotal / qty : 0)}</td>
                        <td>{money(lineTotal)}</td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </Box>
            </Stack>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  Sales Return ID: <b>{detail.id}</b>
                  {' '}| Bill:{' '}
                  {detail.source_bill_id ? (
                    <Link component="button" underline="hover" onClick={() => openBillDetail(detail.source_bill_id, detail.items || [])}>
                      #{detail.source_bill_id}
                    </Link>
                  ) : (
                    <b>-</b>
                  )}
                </Typography>
                <Stack gap={0.25} alignItems={{ md: 'flex-end' }}>
                  <Typography variant="subtitle1">
                    Sales Return Date: <b>{formatDateTime(detail.date_time || detail.created_at)}</b>
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Bill Date: <b>{formatDateTime(detail.source_bill?.date_time)}</b>
                  </Typography>
                </Stack>
              </Stack>

              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ sm: 'center' }}>
                {(() => {
                  const mode = inferReturnRefundMode(detail)
                  const paid = Number(detail.refund_cash || 0) + Number(detail.refund_online || 0)
                  const credited = mode === 'credit' ? Number(detail.subtotal_return || 0) : 0
                  return <>
                <Typography>
                  Settlement Mode: <b>{String(mode).toUpperCase()}</b>
                </Typography>
                <Typography>
                  {mode === 'credit' ? 'Credited to Source Bill' : 'Paid to Customer'}: <b>₹{money(mode === 'credit' ? credited : paid)}</b>
                  {' '}| Cash ₹{money(detail.refund_cash)} | Online ₹{money(detail.refund_online)}
                </Typography>
                  </>
                })()}
                <Button size="small" variant="outlined" onClick={openPaymentEditor} disabled={!canEditPayment}>
                  Edit Customer Payment
                </Button>
                {!canEditPayment ? <Typography variant="caption" color="text.secondary">Manager access required to edit.</Typography> : null}
              </Stack>

              <Divider />

              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>Sale Price</th>
                      <th>Discount</th>
                      <th>Line Refund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.items || []).map((it: any, idx: number) => {
                      const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
                      const qty = Number(it.quantity)
                      const mrp = Number(it.mrp)
                      const sale = detail.source_bill ? billSoldUnitPrice(detail.source_bill, it) : soldUnitPrice(it)
                      const discount = detail.source_bill ? billDiscountPerUnit(detail.source_bill, it) : discountPerUnit(it)
                      const lineRefund = adjustedLineRefund(detail, detail.items || [], it, sale)
                      return (
                        <tr key={idx}>
                          <td>
                            <Stack gap={0.25}>
                              <Typography variant="body2">{name}</Typography>
                              <Typography variant="caption" color="text.secondary">
                                {itemMetaLine(it)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                Batch #{it.batch_number || it.item_id || '-'} | Exp {formatExpiry(it.expiry_date)}
                              </Typography>
                            </Stack>
                          </td>
                          <td>{qty} {itemUnitLabel(it)}</td>
                          <td>₹{money(mrp)}</td>
                          <td>₹{money(sale)}</td>
                          <td>{discount > 0 ? `₹${money(discount)}` : '-'}</td>
                          <td>₹{money(lineRefund)}</td>
                        </tr>
                      )
                    })}

                    {(detail.items || []).length === 0 && (
                      <tr>
                        <td colSpan={6}>
                          <Box p={2} color="text.secondary">
                            No items.
                          </Box>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>

              <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 360 }}>
                <Typography>
                  {inferReturnRefundMode(detail) === 'credit' ? 'Credit Applied:' : 'Customer Refund:'}{' '}
                  <b>
                    {money(
                      actualRefundTotal(detail) ||
                        (detail.subtotal_return ??
                        (detail.items || []).reduce(
                          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
                          0
                        ))
                    )}
                  </b>
                </Typography>
                {detail.notes ? (
                  <Typography sx={{ mt: 1 }}>
                    Notes: <i>{detail.notes}</i>
                  </Typography>
                ) : null}
              </Stack>

              <Divider />
              <Stack gap={0.75}>
                <Typography variant="subtitle2">History</Typography>
                {historyQ.isLoading ? <Typography color="text.secondary">Loading history…</Typography> : null}
                {(historyQ.data || []).map((entry) => {
                  const paymentSummary = auditPaymentSummary(entry.details_json)
                  return (
                    <Paper key={entry.id} variant="outlined" sx={{ p: 1.25 }}>
                      <Typography variant="body2" fontWeight={700}>{entry.note || entry.action}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatDateTime(entry.event_ts)} | {entry.actor || 'SYSTEM'}
                      </Typography>
                      {paymentSummary ? <Typography variant="body2" sx={{ mt: 0.5 }}>{paymentSummary}</Typography> : null}
                    </Paper>
                  )
                })}
                {!historyQ.isLoading && (historyQ.data || []).length === 0 ? (
                  <Typography color="text.secondary">No recorded changes yet.</Typography>
                ) : null}
              </Stack>
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={paymentEditOpen} onClose={() => setPaymentEditOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Customer Payment</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ pt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              Sales return value: ₹{money(detail?.subtotal_return)}. Amounts may differ by up to ₹5 for manual rounding.
            </Typography>
            <TextField
              select
              label="Settlement Mode"
              value={editMode}
              onChange={(event) => {
                const next = event.target.value as 'cash' | 'online' | 'split' | 'credit'
                const returnValue = String(Number(detail?.subtotal_return || 0))
                setEditMode(next)
                if (next === 'cash') { setEditCash(returnValue); setEditOnline('0') }
                if (next === 'online') { setEditCash('0'); setEditOnline(returnValue) }
                if (next === 'credit') { setEditCash('0'); setEditOnline('0') }
              }}
            >
              <MenuItem value="cash">Cash</MenuItem>
              <MenuItem value="online">Online</MenuItem>
              <MenuItem value="split">Split</MenuItem>
              {detail?.source_bill_id ? <MenuItem value="credit">Credit to Source Bill</MenuItem> : null}
            </TextField>
            {editMode === 'cash' || editMode === 'split' ? (
              <TextField label="Cash Paid to Customer" type="number" value={editCash} onChange={(event) => setEditCash(event.target.value)} inputProps={{ min: 0, step: 0.01 }} />
            ) : null}
            {editMode === 'online' || editMode === 'split' ? (
              <TextField label="Online Paid to Customer" type="number" value={editOnline} onChange={(event) => setEditOnline(event.target.value)} inputProps={{ min: 0, step: 0.01 }} />
            ) : null}
            <Typography variant="body2">
              Total paid now:{' '}
              <b>
                ₹{money(
                  (editMode === 'cash' || editMode === 'split' ? Number(editCash || 0) : 0)
                  + (editMode === 'online' || editMode === 'split' ? Number(editOnline || 0) : 0)
                )}
              </b>
            </Typography>
            <Stack direction="row" justifyContent="flex-end" gap={1}>
              <Button onClick={() => setPaymentEditOpen(false)} disabled={mUpdatePayment.isPending}>Cancel</Button>
              <Button variant="contained" onClick={() => mUpdatePayment.mutate()} disabled={mUpdatePayment.isPending}>
                Save Payment
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>

      <Dialog open={billOpen} onClose={() => setBillOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Bill Details {billDetail?.id ? `#${billDetail.id}` : ''}
          <IconButton onClick={() => setBillOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {!billDetail ? (
            <Typography color="text.secondary">Loading…</Typography>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  Bill ID: <b>{billDetail.id}</b>
                </Typography>
                <Typography variant="subtitle1">
                  Bill Date: <b>{formatDateTime(billDetail.date_time || billDetail.created_at)}</b>
                </Typography>
              </Stack>

              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>Sale Price</th>
                      <th>Discount</th>
                      <th>Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(billDetail.items || []).map((it: any, idx: number) => {
                      const qty = Number(it.quantity || 0)
                      const returnedQty = returnedQtyForItem(it)
                      const sale = billSoldUnitPrice(billDetail, it)
                      const discount = billDiscountPerUnit(billDetail, it)
                      const line = qty * sale
                      return (
                        <tr
                          key={`bill-detail-${idx}`}
                          style={returnedQty > 0 ? { backgroundColor: 'rgba(211, 47, 47, 0.10)' } : undefined}
                        >
                          <td>
                            <Stack gap={0.25}>
                              <Typography variant="body2">{it.item_name || `#${it.item_id}`}</Typography>
                              <Typography variant="caption" color="text.secondary">
                                {itemMetaLine(it)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                Batch #{it.batch_number || it.item_id || '-'} | Exp {formatExpiry(it.expiry_date)}
                              </Typography>
                              {returnedQty > 0 ? (
                                <Typography variant="caption" color="error" sx={{ fontWeight: 700 }}>
                                  Returned qty: {returnedQty} {itemUnitLabel(it)}
                                </Typography>
                              ) : null}
                            </Stack>
                          </td>
                          <td>{qty} {itemUnitLabel(it)}</td>
                          <td>₹{money(it.mrp)}</td>
                          <td>₹{money(sale)}</td>
                          <td>{discount > 0 ? `₹${money(discount)}` : '-'}</td>
                          <td>₹{money(line)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Box>

              <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 360 }}>
                <Typography>Total: <b>₹{money(billDetail.total_amount)}</b></Typography>
                <Typography>Payment Mode: <b>{billDetail.payment_mode || '-'}</b></Typography>
                <Typography>Payment Status: <b>{billDetail.payment_status || (billDetail.is_credit ? 'UNPAID' : 'PAID')}</b></Typography>
                <Typography>Paid Amount: <b>₹{money(billDetail.paid_amount)}</b></Typography>
              </Stack>
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
