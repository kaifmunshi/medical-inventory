import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  Divider,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { listBillsPaged, getBill, getSalesAggregate } from '../../services/billing'

type ViewMode = 'details' | 'aggregate'
type GroupBy = 'day' | 'month'

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
  const names = (items || []).map(
    (it: any) => it.item_name || it.name || it.item?.name || `#${it.item_id}`
  )
  if (names.length <= max) return names.join(', ') || '—'
  const head = names.slice(0, max).join(', ')
  return `${head} +${names.length - max} more`
}

function money(n: number | string | undefined | null) {
  const v = Number(n || 0)
  return v.toFixed(2)
}

// ---------- Charged share helpers (same theory as Returns) ----------
function round2(n: number) {
  return Math.round(n * 100) / 100
}

function computeBillProration(bill: any) {
  const items = (bill?.items || []) as any[]
  const sub = items.reduce((s: number, it: any) => s + Number(it.mrp) * Number(it.quantity), 0)

  const discPct = Number(bill?.discount_percent || 0)
  const taxPct = Number(bill?.tax_percent || 0)

  const discAmt = (sub * discPct) / 100
  const afterDisc = sub - discAmt
  const taxAmt = (afterDisc * taxPct) / 100
  const computedTotal = afterDisc + taxAmt

  const finalTotal =
    bill?.total_amount !== undefined && bill?.total_amount !== null
      ? Number(bill.total_amount)
      : computedTotal

  const factor = computedTotal > 0 ? finalTotal / computedTotal : 1

  return { discPct, taxPct, computedTotal, finalTotal, factor }
}

function chargedLine(bill: any, mrp: number, qty: number) {
  const { discPct, taxPct, factor } = computeBillProration(bill)

  const lineSub = Number(mrp) * Number(qty)
  const afterDisc = lineSub * (1 - discPct / 100)
  const afterTax = afterDisc * (1 + taxPct / 100)

  return round2(afterTax * factor)
}

export default function SalesReport(props: {
  from: string
  to: string
  q: string
  viewMode: ViewMode
  groupBy: GroupBy
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
}) {
  const { from, to, q, viewMode, groupBy, setExportFn, setExportDisabled } = props

  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const LIMIT = 30

  // Detail dialog
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<any | null>(null)

  // SALES DETAILS (paged)
  const qSales = useInfiniteQuery({
    queryKey: ['rpt-sales', 'details', from, to, debouncedQ],
    enabled: viewMode === 'details',
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      return await listBillsPaged({
        from_date: from,
        to_date: to,
        q: debouncedQ,
        limit: LIMIT,
        offset: pageParam,
      })
    },
    getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
  })

  // SALES AGGREGATE
  const qAgg = useQuery({
    queryKey: ['rpt-sales', 'aggregate', from, to, groupBy],
    enabled: viewMode === 'aggregate',
    queryFn: () => getSalesAggregate({ from_date: from, to_date: to, group_by: groupBy }),
  })

  const salesRaw = useMemo(() => {
    const pages: any[] = ((qSales.data as any)?.pages ?? []) as any[]
    return pages.flatMap((p) => (Array.isArray(p?.items) ? p.items : []))
  }, [qSales.data])

  const detailRows = useMemo(() => {
    const bills = (salesRaw || []) as any[]
    return bills.map((b) => {
      const sub = (b.items || []).reduce(
        (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
        0
      )
      const disc = (sub * Number(b.discount_percent || 0)) / 100
      const afterDisc = sub - disc
      const tax = (afterDisc * Number(b.tax_percent || 0)) / 100

      const totalAmount =
        b.total_amount !== undefined && b.total_amount !== null
          ? Number(b.total_amount)
          : afterDisc + tax

      const paidAmount =
        b.paid_amount !== undefined && b.paid_amount !== null ? Number(b.paid_amount) : 0

      const pendingAmount = Math.max(0, totalAmount - paidAmount)

      const status =
        b.payment_status ||
        (pendingAmount <= 0.0001 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID')

      return {
        raw: b,
        id: b.id,
        date: b.date_time || b.created_at || '',
        itemsCount: (b.items || []).length,
        itemsPreview: itemsPreview(b.items || []),
        subtotal: money(sub),
        discount: money(disc),
        tax: money(tax),
        total: money(totalAmount),
        paid: money(paidAmount),
        pending: money(pendingAmount),
        status,
        mode: b.payment_mode || '',
      }
    })
  }, [salesRaw])

  async function openDetail(row: any) {
    let b = row.raw
    if (!b?.items || !Array.isArray(b.items) || b.items.length === 0) {
      try {
        b = await getBill(row.id)
      } catch {}
    }
    setDetail(b)
    setOpen(true)
  }

  // export
  useEffect(() => {
    const exportDisabled =
      viewMode === 'aggregate'
        ? ((qAgg.data || []) as any[]).length === 0
        : detailRows.length === 0

    setExportDisabled(exportDisabled)

    setExportFn(() => () => {
      // aggregate export
      if (viewMode === 'aggregate') {
        const agg = (qAgg.data || []) as any[]
        const header = ['Period', 'Bills', 'Gross Sales', 'Paid', 'Pending']
        const body = agg.map((x: any) => [
          x.period,
          String(x.bills_count),
          money(x.gross_sales),
          money(x.paid_total),
          money(x.pending_total),
        ])
        const csv = toCSV([header, ...body])
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `sales-aggregate-${groupBy}_${from}_to_${to}.csv`
        a.click()
        URL.revokeObjectURL(url)
        return
      }

      // details export
      const header = [
        'Bill ID',
        'Date/Time',
        'Items',
        'Subtotal',
        'Discount',
        'Tax',
        'Total',
        'Paid',
        'Pending',
        'Status',
        'Payment Mode',
      ]

      const body = detailRows.map((r: any) => [
        r.id,
        r.date,
        r.itemsCount,
        r.subtotal,
        r.discount,
        r.tax,
        r.total,
        r.paid,
        r.pending,
        r.status,
        r.mode,
      ])

      const csv = toCSV([header, ...body])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sales-report_${from}_to_${to}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
  }, [setExportDisabled, setExportFn, viewMode, qAgg.data, detailRows, from, to, groupBy])

  // infinite scroll only in details
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (viewMode !== 'details') return
    const el = loadMoreRef.current
    if (!el) return

    const obs = new IntersectionObserver(
      (entries) => {
        const first = entries[0]
        if (first.isIntersecting && qSales.hasNextPage && !qSales.isFetchingNextPage) {
          qSales.fetchNextPage()
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 }
    )

    obs.observe(el)
    return () => obs.disconnect()
  }, [viewMode, qSales.fetchNextPage, qSales.hasNextPage, qSales.isFetchingNextPage])

  const isLoading = viewMode === 'aggregate' ? qAgg.isLoading : qSales.isLoading
  const isError = viewMode === 'aggregate' ? qAgg.isError : qSales.isError

  const aggRows = (qAgg.data || []) as any[]

  return (
    <>
      {viewMode === 'aggregate' ? (
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{groupBy === 'day' ? 'Date' : 'Month'}</th>
                <th>Bills</th>
                <th>Gross Sales</th>
                <th>Paid</th>
                <th>Pending</th>
              </tr>
            </thead>
            <tbody>
              {aggRows.map((x: any) => (
                <tr key={x.period}>
                  <td>{x.period}</td>
                  <td>{x.bills_count}</td>
                  <td>{money(x.gross_sales)}</td>
                  <td>{money(x.paid_total)}</td>
                  <td>{money(x.pending_total)}</td>
                </tr>
              ))}
              {aggRows.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={5}>
                    <Box p={2} color="text.secondary">
                      No data.
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      ) : (
        <>
          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Bill ID</th>
                  <th>Date/Time</th>
                  <th>Items</th>
                  <th>Subtotal</th>
                  <th>Discount</th>
                  <th>Tax</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Pending</th>
                  <th>Status</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.map((r: any) => (
                  <tr key={`b-${r.id}`}>
                    <td>
                      <Tooltip title={r.itemsPreview} arrow placement="top">
                        <Link component="button" onClick={() => openDetail(r)} underline="hover">
                          {r.id}
                        </Link>
                      </Tooltip>
                    </td>
                    <td>{r.date}</td>
                    <td>{r.itemsCount}</td>
                    <td>{r.subtotal}</td>
                    <td>{r.discount}</td>
                    <td>{r.tax}</td>
                    <td>{r.total}</td>
                    <td>{r.paid}</td>
                    <td>{r.pending}</td>
                    <td>{r.status}</td>
                    <td>{r.mode}</td>
                  </tr>
                ))}

                {detailRows.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={11}>
                      <Box p={2} color="text.secondary">
                        No data.
                      </Box>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>

          {/* status */}
          {isLoading && (
            <Box sx={{ py: 2, textAlign: 'center' }}>
              <Typography variant="body2">Loading…</Typography>
            </Box>
          )}

          {isError && (
            <Box sx={{ py: 2, textAlign: 'center' }}>
              <Typography variant="body2" color="error">
                Failed to load.
              </Typography>
            </Box>
          )}

          {/* infinite scroll */}
          <div ref={loadMoreRef} style={{ height: 1 }} />

          {qSales.isFetchingNextPage && (
            <Box sx={{ py: 2, textAlign: 'center' }}>
              <Typography variant="body2">Loading more…</Typography>
            </Box>
          )}

          {!qSales.hasNextPage && detailRows.length > 0 && (
            <Box sx={{ py: 2, textAlign: 'center' }}>
              <Typography variant="body2">End of list</Typography>
            </Box>
          )}
        </>
      )}

      {/* Bill Detail dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Bill Details
          <IconButton onClick={() => setOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers>
          {!detail ? (
            <Typography color="text.secondary">Loading…</Typography>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  ID: <b>{detail.id}</b>
                </Typography>
                <Typography variant="subtitle1">
                  Date/Time: <b>{detail.date_time || detail.created_at || '-'}</b>
                </Typography>
              </Stack>

              <Divider />

              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.items || []).map((it: any, idx: number) => {
                      const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
                      const qty = Number(it.quantity)
                      const mrp = Number(it.mrp)
                      return (
                        <tr key={idx}>
                          <td>{name}</td>
                          <td>{qty}</td>
                          <td>{money(mrp)}</td>

                          {/* ✅ FIX: show charged share, not raw mrp*qty */}
                          <td>{money(chargedLine(detail, mrp, qty))}</td>
                        </tr>
                      )
                    })}

                    {(detail.items || []).length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <Box p={2} color="text.secondary">
                            No items.
                          </Box>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>

              <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 420 }}>
                <Typography>
                  Total: <b>{money(detail.total_amount || 0)}</b>
                </Typography>
                <Typography>
                  Payment Mode: <b>{detail.payment_mode || '-'}</b>
                </Typography>
                <Typography>
                  Payment Status: <b>{detail.payment_status || (detail.is_credit ? 'UNPAID' : 'PAID')}</b>
                </Typography>
                <Typography>
                  Paid Amount: <b>{money(detail.paid_amount || 0)}</b>
                </Typography>
                <Typography>
                  Pending Amount:{' '}
                  <b>{money(Math.max(0, Number(detail.total_amount || 0) - Number(detail.paid_amount || 0)))}</b>
                </Typography>
                {detail.notes ? (
                  <Typography sx={{ mt: 1 }}>
                    Notes: <i>{detail.notes}</i>
                  </Typography>
                ) : null}
              </Stack>
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
