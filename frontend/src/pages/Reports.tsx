// F:\medical-inventory\frontend\src\pages\Reports.tsx

import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { listBillsPaged, getBill, getSalesAggregate } from '../services/billing'
import { listReturns, getReturn } from '../services/returns'
import { todayRange } from '../lib/date'

type Tab = 'sales' | 'returns'
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

export default function Reports() {
  const { from: todayFrom, to: todayTo } = todayRange()

  const [tab, setTab] = useState<Tab>('sales')
  const [viewMode, setViewMode] = useState<ViewMode>('details')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')

  const [from, setFrom] = useState(todayFrom)
  const [to, setTo] = useState(todayTo)

  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  // ✅ page size for details infinite scroll
  const LIMIT = 30

  // Detail dialog state
  const [open, setOpen] = useState(false)
  const [detailType, setDetailType] = useState<'bill' | 'return' | null>(null)
  const [detail, setDetail] = useState<any | null>(null)

  // ✅ When switching tab away from sales, force viewMode to details
  useEffect(() => {
    if (tab !== 'sales' && viewMode === 'aggregate') setViewMode('details')
  }, [tab, viewMode])

  // ----------------------------
  // SALES DETAILS (paged)
  // ----------------------------
  const qSales = useInfiniteQuery({
    queryKey: ['rpt-sales', 'details', from, to, debouncedQ],
    enabled: tab === 'sales' && viewMode === 'details',
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

  // ----------------------------
  // RETURNS (kept as-is)
  // ----------------------------
  const qRets = useInfiniteQuery({
    queryKey: ['rpt-returns', from, to],
    enabled: tab === 'returns',
    initialPageParam: 0,
    queryFn: async () => {
      return await listReturns({ from_date: from, to_date: to, limit: 500 })
    },
    getNextPageParam: () => undefined,
  })

  // ----------------------------
  // SALES AGGREGATE (new)
  // ----------------------------
  const qAgg = useQuery({
    queryKey: ['rpt-sales', 'aggregate', from, to, groupBy],
    enabled: tab === 'sales' && viewMode === 'aggregate',
    queryFn: () => getSalesAggregate({ from_date: from, to_date: to, group_by: groupBy }),
  })

  const salesRaw = useMemo(() => {
    const pages: any[] = ((qSales.data as any)?.pages ?? []) as any[]
    return pages.flatMap((p) => (Array.isArray(p?.items) ? p.items : []))
  }, [qSales.data])

  const returnsRaw = useMemo(() => {
    const pages: any[] = ((qRets.data as any)?.pages ?? []) as any[]
    const all: any[] = []
    for (const p of pages) if (Array.isArray(p)) all.push(...p)
    return all
  }, [qRets.data])

  const detailRows = useMemo(() => {
    if (tab === 'sales') {
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
          b.total_amount !== undefined && b.total_amount !== null ? Number(b.total_amount) : afterDisc + tax

        const paidAmount =
          b.paid_amount !== undefined && b.paid_amount !== null ? Number(b.paid_amount) : 0

        const pendingAmount = Math.max(0, totalAmount - paidAmount)

        const status =
          b.payment_status || (pendingAmount <= 0.0001 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID')

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
    } else {
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
          notes: r.notes || '',
        }
      })
    }
  }, [tab, salesRaw, returnsRaw])

  async function openDetail(row: any) {
    if (tab === 'sales') {
      let b = row.raw
      if (!b?.items || !Array.isArray(b.items) || b.items.length === 0) {
        try {
          b = await getBill(row.id)
        } catch {}
      }
      setDetailType('bill')
      setDetail(b)
      setOpen(true)
    } else {
      let r = row.raw
      if (!r?.items || !Array.isArray(r.items) || r.items.length === 0) {
        try {
          r = await getReturn(row.id)
        } catch {}
      }
      setDetailType('return')
      setDetail(r)
      setOpen(true)
    }
  }

  function downloadCSV() {
    // ✅ Aggregate export
    if (tab === 'sales' && viewMode === 'aggregate') {
      const agg = (qAgg.data || []) as any[]
      const header = ['Period', 'Bills', 'Gross Sales', 'Paid', 'Pending']
      const body = agg.map((x: any) => [
        x.period,
        x.bills_count,
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

    // ✅ Details export (existing)
    const header =
      tab === 'sales'
        ? [
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
        : ['Return ID', 'Date/Time', 'Lines', 'Refund', 'Notes']

    const body = (detailRows as any[]).map((r: any) =>
      tab === 'sales'
        ? [r.id, r.date, r.itemsCount, r.subtotal, r.discount, r.tax, r.total, r.paid, r.pending, r.status, r.mode]
        : [r.id, r.date, r.linesCount, r.refund, r.notes]
    )

    const csv = toCSV([header, ...body])
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tab}-report_${from}_to_${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Infinite scroll only for details view
  const activeFetchNextPage = tab === 'sales' ? qSales.fetchNextPage : qRets.fetchNextPage
  const activeHasNextPage = tab === 'sales' ? qSales.hasNextPage : qRets.hasNextPage
  const activeIsFetchingNextPage = tab === 'sales' ? qSales.isFetchingNextPage : qRets.isFetchingNextPage

  const isLoading =
    tab === 'sales'
      ? viewMode === 'aggregate'
        ? qAgg.isLoading
        : qSales.isLoading
      : qRets.isLoading

  const isError =
    tab === 'sales'
      ? viewMode === 'aggregate'
        ? qAgg.isError
        : qSales.isError
      : qRets.isError

  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!(tab === 'sales' && viewMode === 'details')) return
    const el = loadMoreRef.current
    if (!el) return

    const obs = new IntersectionObserver(
      (entries) => {
        const first = entries[0]
        if (first.isIntersecting && activeHasNextPage && !activeIsFetchingNextPage) {
          activeFetchNextPage()
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 }
    )

    obs.observe(el)
    return () => obs.disconnect()
  }, [tab, viewMode, activeFetchNextPage, activeHasNextPage, activeIsFetchingNextPage])

  const aggRows = (qAgg.data || []) as any[]

  return (
    <>
      <Stack gap={2}>
        <Typography variant="h5">Reports</Typography>

        <Paper sx={{ p: 2 }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            gap={2}
            alignItems={{ md: 'center' }}
            justifyContent="space-between"
          >
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <TextField
                select
                label="Report"
                value={tab}
                onChange={(e) => setTab(e.target.value as Tab)}
                sx={{ width: 160 }}
              >
                <MenuItem value="sales">Sales</MenuItem>
                <MenuItem value="returns">Returns</MenuItem>
              </TextField>

              {tab === 'sales' && (
                <TextField
                  select
                  label="View"
                  value={viewMode}
                  onChange={(e) => setViewMode(e.target.value as ViewMode)}
                  sx={{ width: 160 }}
                >
                  <MenuItem value="details">Details</MenuItem>
                  <MenuItem value="aggregate">Aggregate</MenuItem>
                </TextField>
              )}

              {tab === 'sales' && viewMode === 'aggregate' && (
                <TextField
                  select
                  label="Group By"
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                  sx={{ width: 160 }}
                >
                  <MenuItem value="day">Daily</MenuItem>
                  <MenuItem value="month">Monthly</MenuItem>
                </TextField>
              )}

              <TextField
                label="From"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />

              <TextField
                label="To"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />

              {tab === 'sales' && viewMode === 'details' && (
                <TextField
                  label="Search (id/item/notes)"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              )}
            </Stack>

            <Button variant="outlined" onClick={downloadCSV} disabled={tab === 'sales' && viewMode === 'aggregate' ? aggRows.length === 0 : (detailRows as any[]).length === 0}>
              Export CSV
            </Button>
          </Stack>
        </Paper>

        <Paper sx={{ p: 2 }}>
          {tab === 'sales' && viewMode === 'aggregate' ? (
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
            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  {tab === 'sales' ? (
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
                  ) : (
                    <tr>
                      <th>Return ID</th>
                      <th>Date/Time</th>
                      <th>Lines</th>
                      <th>Refund</th>
                      <th>Notes</th>
                    </tr>
                  )}
                </thead>

                <tbody>
                  {(detailRows as any[]).map((r: any) =>
                    tab === 'sales' ? (
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
                    ) : (
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
                        <td>{r.notes}</td>
                      </tr>
                    )
                  )}

                  {(detailRows as any[]).length === 0 && !isLoading && (
                    <tr>
                      <td colSpan={tab === 'sales' ? 11 : 5}>
                        <Box p={2} color="text.secondary">
                          No data.
                        </Box>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Box>
          )}

          {/* status lines */}
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

          {/* infinite scroll only for sales details */}
          {tab === 'sales' && viewMode === 'details' && (
            <>
              <div ref={loadMoreRef} style={{ height: 1 }} />

              {activeIsFetchingNextPage && (
                <Box sx={{ py: 2, textAlign: 'center' }}>
                  <Typography variant="body2">Loading more…</Typography>
                </Box>
              )}

              {!activeHasNextPage && (detailRows as any[]).length > 0 && (
                <Box sx={{ py: 2, textAlign: 'center' }}>
                  <Typography variant="body2">End of list</Typography>
                </Box>
              )}
            </>
          )}
        </Paper>
      </Stack>

      {/* Detail dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {detailType === 'bill' ? 'Bill Details' : 'Return Details'}
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
                          <td>{money(qty * mrp)}</td>
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

              {detailType === 'bill' ? (
                <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 420 }}>
                  <Typography>
                    Total: <b>{money(detail.total_amount || 0)}</b>
                  </Typography>
                  <Typography>
                    Payment Mode: <b>{detail.payment_mode || '-'}</b>
                  </Typography>
                  <Typography>
                    Payment Status:{' '}
                    <b>{detail.payment_status || (detail.is_credit ? 'UNPAID' : 'PAID')}</b>
                  </Typography>
                  <Typography>
                    Paid Amount: <b>{money(detail.paid_amount || 0)}</b>
                  </Typography>
                  <Typography>
                    Pending Amount:{' '}
                    <b>
                      {money(
                        Math.max(0, Number(detail.total_amount || 0) - Number(detail.paid_amount || 0))
                      )}
                    </b>
                  </Typography>
                  {detail.notes ? (
                    <Typography sx={{ mt: 1 }}>
                      Notes: <i>{detail.notes}</i>
                    </Typography>
                  ) : null}
                </Stack>
              ) : (
                <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 360 }}>
                  <Typography>
                    Refund:{' '}
                    <b>
                      {money(
                        detail.subtotal_return ??
                          (detail.items || []).reduce(
                            (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
                            0
                          )
                      )}
                    </b>
                  </Typography>
                  {detail.notes ? (
                    <Typography sx={{ mt: 1 }}>
                      Notes: <i>{detail.notes}</i>
                    </Typography>
                  ) : null}
                </Stack>
              )}
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
