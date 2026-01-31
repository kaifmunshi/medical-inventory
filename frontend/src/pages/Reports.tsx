// // frontend/src/pages/Reports.tsx

// import { useEffect, useMemo, useRef, useState } from 'react'
// import {
//   Box,
//   Button,
//   Dialog,
//   DialogTitle,
//   DialogContent,
//   Divider,
//   IconButton,
//   Link,
//   MenuItem,
//   Paper,
//   Stack,
//   TextField,
//   Tooltip,
//   Typography,
// } from '@mui/material'
// import CloseIcon from '@mui/icons-material/Close'
// import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

// import { listBillsPaged, getBill, getSalesAggregate } from '../services/billing'
// import { listReturns, getReturn } from '../services/returns'
// import { listItems, getItemLedger } from '../services/inventory'
// import { todayRange } from '../lib/date'

// type Tab = 'sales' | 'returns' | 'stock'
// type ViewMode = 'details' | 'aggregate'
// type GroupBy = 'day' | 'month'

// function toCSV(rows: string[][]) {
//   return rows
//     .map((r) =>
//       r
//         .map((cell) => {
//           const s = String(cell ?? '')
//           return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
//         })
//         .join(',')
//     )
//     .join('\n')
// }

// function itemsPreview(items: any[], max = 6) {
//   const names = (items || []).map(
//     (it: any) => it.item_name || it.name || it.item?.name || `#${it.item_id}`
//   )
//   if (names.length <= max) return names.join(', ') || '—'
//   const head = names.slice(0, max).join(', ')
//   return `${head} +${names.length - max} more`
// }

// function money(n: number | string | undefined | null) {
//   const v = Number(n || 0)
//   return v.toFixed(2)
// }

// export default function Reports() {
//   const { from: todayFrom, to: todayTo } = todayRange()

//   const [tab, setTab] = useState<Tab>('sales')
//   const [viewMode, setViewMode] = useState<ViewMode>('details')
//   const [groupBy, setGroupBy] = useState<GroupBy>('day')

//   const [from, setFrom] = useState(todayFrom)
//   const [to, setTo] = useState(todayTo)

//   const [q, setQ] = useState('')
//   const [debouncedQ, setDebouncedQ] = useState('')

//   useEffect(() => {
//     const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
//     return () => clearTimeout(t)
//   }, [q])

//   // ✅ page size for details infinite scroll
//   const LIMIT = 30

//   // Detail dialog state
//   const [open, setOpen] = useState(false)
//   const [detailType, setDetailType] = useState<'bill' | 'return' | null>(null)
//   const [detail, setDetail] = useState<any | null>(null)

//   // ✅ Stock ledger item picker
//   const [itemPickerOpen, setItemPickerOpen] = useState(false)
//   const [itemSearch, setItemSearch] = useState('')
//   const [debouncedItemSearch, setDebouncedItemSearch] = useState('')
//   const [pickedItem, setPickedItem] = useState<any | null>(null)
//   const [ledgerReason, setLedgerReason] = useState<string>('') // empty = all

//   useEffect(() => {
//     const t = setTimeout(() => setDebouncedItemSearch(itemSearch.trim()), 300)
//     return () => clearTimeout(t)
//   }, [itemSearch])

//   // ✅ When switching tab away from sales, force viewMode to details
//   useEffect(() => {
//     if (tab !== 'sales' && viewMode === 'aggregate') setViewMode('details')
//   }, [tab, viewMode])

//   // ✅ When switching to stock, force viewMode to details
//   useEffect(() => {
//     if (tab === 'stock') setViewMode('details')
//   }, [tab])

//   // ----------------------------
//   // SALES DETAILS (paged)
//   // ----------------------------
//   const qSales = useInfiniteQuery({
//     queryKey: ['rpt-sales', 'details', from, to, debouncedQ],
//     enabled: tab === 'sales' && viewMode === 'details',
//     initialPageParam: 0,
//     queryFn: async ({ pageParam }) => {
//       return await listBillsPaged({
//         from_date: from,
//         to_date: to,
//         q: debouncedQ,
//         limit: LIMIT,
//         offset: pageParam,
//       })
//     },
//     getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
//   })

//   // ----------------------------
//   // RETURNS (kept as-is)
//   // ----------------------------
//   const qRets = useInfiniteQuery({
//     queryKey: ['rpt-returns', from, to],
//     enabled: tab === 'returns',
//     initialPageParam: 0,
//     queryFn: async () => {
//       return await listReturns({ from_date: from, to_date: to, limit: 500 })
//     },
//     getNextPageParam: () => undefined,
//   })

//   // ----------------------------
//   // SALES AGGREGATE (new)
//   // ----------------------------
//   const qAgg = useQuery({
//     queryKey: ['rpt-sales', 'aggregate', from, to, groupBy],
//     enabled: tab === 'sales' && viewMode === 'aggregate',
//     queryFn: () => getSalesAggregate({ from_date: from, to_date: to, group_by: groupBy }),
//   })

//   // ----------------------------
//   // STOCK ITEM SEARCH (dialog list)
//   // ----------------------------
//   const qItemSearch = useQuery({
//     queryKey: ['rpt-stock-items', debouncedItemSearch],
//     enabled: itemPickerOpen && debouncedItemSearch.length > 0,
//     queryFn: () => listItems(debouncedItemSearch),
//   })

//   // ----------------------------
//   // STOCK LEDGER (paged)
//   // ----------------------------
//   const qLedger = useInfiniteQuery({
//     queryKey: ['rpt-stock-ledger', pickedItem?.id, from, to, ledgerReason],
//     enabled: tab === 'stock' && !!pickedItem?.id,
//     initialPageParam: 0,
//     queryFn: async ({ pageParam }) => {
//       return await getItemLedger({
//         item_id: Number(pickedItem.id),
//         from_date: from,
//         to_date: to,
//         reason: ledgerReason ? ledgerReason : undefined,
//         limit: LIMIT,
//         offset: pageParam,
//       })
//     },
//     getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
//   })

//   const salesRaw = useMemo(() => {
//     const pages: any[] = ((qSales.data as any)?.pages ?? []) as any[]
//     return pages.flatMap((p) => (Array.isArray(p?.items) ? p.items : []))
//   }, [qSales.data])

//   const returnsRaw = useMemo(() => {
//     const pages: any[] = ((qRets.data as any)?.pages ?? []) as any[]
//     const all: any[] = []
//     for (const p of pages) if (Array.isArray(p)) all.push(...p)
//     return all
//   }, [qRets.data])

//   const ledgerRaw = useMemo(() => {
//     const pages: any[] = ((qLedger.data as any)?.pages ?? []) as any[]
//     const rows: any[] = []
//     for (const p of pages) {
//       if (p && Array.isArray(p.items)) rows.push(...p.items)
//     }
//     return rows
//   }, [qLedger.data])

//   const detailRows = useMemo(() => {
//     if (tab === 'sales') {
//       const bills = (salesRaw || []) as any[]
//       return bills.map((b) => {
//         const sub = (b.items || []).reduce(
//           (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
//           0
//         )
//         const disc = (sub * Number(b.discount_percent || 0)) / 100
//         const afterDisc = sub - disc
//         const tax = (afterDisc * Number(b.tax_percent || 0)) / 100

//         const totalAmount =
//           b.total_amount !== undefined && b.total_amount !== null ? Number(b.total_amount) : afterDisc + tax

//         const paidAmount =
//           b.paid_amount !== undefined && b.paid_amount !== null ? Number(b.paid_amount) : 0

//         const pendingAmount = Math.max(0, totalAmount - paidAmount)

//         const status =
//           b.payment_status || (pendingAmount <= 0.0001 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID')

//         return {
//           raw: b,
//           id: b.id,
//           date: b.date_time || b.created_at || '',
//           itemsCount: (b.items || []).length,
//           itemsPreview: itemsPreview(b.items || []),
//           subtotal: money(sub),
//           discount: money(disc),
//           tax: money(tax),
//           total: money(totalAmount),
//           paid: money(paidAmount),
//           pending: money(pendingAmount),
//           status,
//           mode: b.payment_mode || '',
//         }
//       })
//     } else if (tab === 'returns') {
//       const rets = (returnsRaw || []) as any[]
//       return rets.map((r) => {
//         const refundCalc = (r.items || []).reduce(
//           (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
//           0
//         )
//         const refund = r.subtotal_return ?? refundCalc
//         return {
//           raw: r,
//           id: r.id,
//           date: r.date_time || r.created_at || '',
//           linesCount: (r.items || []).length,
//           itemsPreview: itemsPreview(r.items || []),
//           refund: money(refund),
//           notes: r.notes || '',
//         }
//       })
//     } else {
//       // stock ledger rows
//       return ledgerRaw.map((m: any) => ({
//         id: m.id,
//         ts: m.ts,
//         delta: Number(m.delta || 0),
//         reason: m.reason || '',
//         ref_type: m.ref_type || '',
//         ref_id: m.ref_id ?? '',
//         note: m.note || '',
//         before: Number(m.balance_before ?? 0),
//         after: Number(m.balance_after ?? 0),
//       }))
//     }
//   }, [tab, salesRaw, returnsRaw, ledgerRaw])

//   async function openDetail(row: any) {
//     if (tab === 'sales') {
//       let b = row.raw
//       if (!b?.items || !Array.isArray(b.items) || b.items.length === 0) {
//         try {
//           b = await getBill(row.id)
//         } catch {}
//       }
//       setDetailType('bill')
//       setDetail(b)
//       setOpen(true)
//     } else {
//       let r = row.raw
//       if (!r?.items || !Array.isArray(r.items) || r.items.length === 0) {
//         try {
//           r = await getReturn(row.id)
//         } catch {}
//       }
//       setDetailType('return')
//       setDetail(r)
//       setOpen(true)
//     }
//   }

//   function downloadCSV() {
//     // ✅ Aggregate export
//     if (tab === 'sales' && viewMode === 'aggregate') {
//       const agg = (qAgg.data || []) as any[]
//       const header = ['Period', 'Bills', 'Gross Sales', 'Paid', 'Pending']
//       const body = agg.map((x: any) => [
//         x.period,
//         String(x.bills_count),
//         money(x.gross_sales),
//         money(x.paid_total),
//         money(x.pending_total),
//       ])
//       const csv = toCSV([header, ...body])
//       const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
//       const url = URL.createObjectURL(blob)
//       const a = document.createElement('a')
//       a.href = url
//       a.download = `sales-aggregate-${groupBy}_${from}_to_${to}.csv`
//       a.click()
//       URL.revokeObjectURL(url)
//       return
//     }

//     // ✅ Stock export
//     if (tab === 'stock') {
//       const header = ['ID', 'TS', 'Delta', 'Reason', 'Ref Type', 'Ref ID', 'Before', 'After', 'Note']
//       const body = (detailRows as any[]).map((r: any) => [
//         String(r.id),
//         String(r.ts),
//         String(r.delta),
//         String(r.reason),
//         String(r.ref_type ?? ''),
//         String(r.ref_id ?? ''),
//         String(r.before ?? ''),
//         String(r.after ?? ''),
//         String(r.note ?? ''),
//       ])
//       const csv = toCSV([header, ...body])
//       const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
//       const url = URL.createObjectURL(blob)
//       const a = document.createElement('a')
//       a.href = url
//       a.download = `stock-ledger_${pickedItem?.id ?? 'item'}_${from}_to_${to}.csv`
//       a.click()
//       URL.revokeObjectURL(url)
//       return
//     }

//     // ✅ Details export (existing)
//     const header =
//       tab === 'sales'
//         ? [
//             'Bill ID',
//             'Date/Time',
//             'Items',
//             'Subtotal',
//             'Discount',
//             'Tax',
//             'Total',
//             'Paid',
//             'Pending',
//             'Status',
//             'Payment Mode',
//           ]
//         : ['Return ID', 'Date/Time', 'Lines', 'Refund', 'Notes']

//     const body = (detailRows as any[]).map((r: any) =>
//       tab === 'sales'
//         ? [r.id, r.date, r.itemsCount, r.subtotal, r.discount, r.tax, r.total, r.paid, r.pending, r.status, r.mode]
//         : [r.id, r.date, r.linesCount, r.refund, r.notes]
//     )

//     const csv = toCSV([header, ...body])
//     const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
//     const url = URL.createObjectURL(blob)
//     const a = document.createElement('a')
//     a.href = url
//     a.download = `${tab}-report_${from}_to_${to}.csv`
//     a.click()
//     URL.revokeObjectURL(url)
//   }

//   // Infinite scroll: sales details + stock ledger
//   const activeFetchNextPage =
//     tab === 'sales' ? qSales.fetchNextPage : tab === 'stock' ? qLedger.fetchNextPage : qRets.fetchNextPage

//   const activeHasNextPage =
//     tab === 'sales' ? qSales.hasNextPage : tab === 'stock' ? qLedger.hasNextPage : qRets.hasNextPage

//   const activeIsFetchingNextPage =
//     tab === 'sales' ? qSales.isFetchingNextPage : tab === 'stock' ? qLedger.isFetchingNextPage : qRets.isFetchingNextPage

//   const isLoading =
//     tab === 'sales'
//       ? viewMode === 'aggregate'
//         ? qAgg.isLoading
//         : qSales.isLoading
//       : tab === 'returns'
//         ? qRets.isLoading
//         : qLedger.isLoading

//   const isError =
//     tab === 'sales'
//       ? viewMode === 'aggregate'
//         ? qAgg.isError
//         : qSales.isError
//       : tab === 'returns'
//         ? qRets.isError
//         : qLedger.isError

//   const loadMoreRef = useRef<HTMLDivElement | null>(null)

//   useEffect(() => {
//     // Only enable infinite scroll for SALES details and STOCK ledger
//     const enabled =
//       (tab === 'sales' && viewMode === 'details') ||
//       (tab === 'stock' && !!pickedItem?.id)

//     if (!enabled) return

//     const el = loadMoreRef.current
//     if (!el) return

//     const obs = new IntersectionObserver(
//       (entries) => {
//         const first = entries[0]
//         if (first.isIntersecting && activeHasNextPage && !activeIsFetchingNextPage) {
//           activeFetchNextPage()
//         }
//       },
//       { root: null, rootMargin: '200px', threshold: 0 }
//     )

//     obs.observe(el)
//     return () => obs.disconnect()
//   }, [tab, viewMode, pickedItem?.id, activeFetchNextPage, activeHasNextPage, activeIsFetchingNextPage])

//   const aggRows = (qAgg.data || []) as any[]

//   const exportDisabled = useMemo(() => {
//     if (tab === 'sales' && viewMode === 'aggregate') return aggRows.length === 0
//     if (tab === 'stock') return (detailRows as any[]).length === 0
//     return (detailRows as any[]).length === 0
//   }, [tab, viewMode, aggRows.length, detailRows])

//   return (
//     <>
//       <Stack gap={2}>
//         <Typography variant="h5">Reports</Typography>

//         <Paper sx={{ p: 2 }}>
//           <Stack
//             direction={{ xs: 'column', md: 'row' }}
//             gap={2}
//             alignItems={{ md: 'center' }}
//             justifyContent="space-between"
//           >
//             <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
//               <TextField
//                 select
//                 label="Report"
//                 value={tab}
//                 onChange={(e) => setTab(e.target.value as Tab)}
//                 sx={{ width: 180 }}
//               >
//                 <MenuItem value="sales">Sales</MenuItem>
//                 <MenuItem value="returns">Returns</MenuItem>
//                 <MenuItem value="stock">Stock Ledger</MenuItem>
//               </TextField>

//               {tab === 'sales' && (
//                 <TextField
//                   select
//                   label="View"
//                   value={viewMode}
//                   onChange={(e) => setViewMode(e.target.value as ViewMode)}
//                   sx={{ width: 160 }}
//                 >
//                   <MenuItem value="details">Details</MenuItem>
//                   <MenuItem value="aggregate">Aggregate</MenuItem>
//                 </TextField>
//               )}

//               {tab === 'sales' && viewMode === 'aggregate' && (
//                 <TextField
//                   select
//                   label="Group By"
//                   value={groupBy}
//                   onChange={(e) => setGroupBy(e.target.value as GroupBy)}
//                   sx={{ width: 160 }}
//                 >
//                   <MenuItem value="day">Daily</MenuItem>
//                   <MenuItem value="month">Monthly</MenuItem>
//                 </TextField>
//               )}

//               <TextField
//                 label="From"
//                 type="date"
//                 value={from}
//                 onChange={(e) => setFrom(e.target.value)}
//                 InputLabelProps={{ shrink: true }}
//               />

//               <TextField
//                 label="To"
//                 type="date"
//                 value={to}
//                 onChange={(e) => setTo(e.target.value)}
//                 InputLabelProps={{ shrink: true }}
//               />

//               {tab === 'sales' && viewMode === 'details' && (
//                 <TextField
//                   label="Search (id/item/notes)"
//                   value={q}
//                   onChange={(e) => setQ(e.target.value)}
//                 />
//               )}

//               {tab === 'stock' && (
//                 <>
//                   <Button
//                     variant="outlined"
//                     onClick={() => setItemPickerOpen(true)}
//                   >
//                     {pickedItem ? `Item: ${pickedItem.name} (#${pickedItem.id})` : 'Pick Item'}
//                   </Button>

//                   <TextField
//                     select
//                     label="Reason"
//                     value={ledgerReason}
//                     onChange={(e) => setLedgerReason(e.target.value)}
//                     sx={{ width: 160 }}
//                   >
//                     <MenuItem value="">All</MenuItem>
//                     <MenuItem value="OPENING">OPENING</MenuItem>
//                     <MenuItem value="ADJUST">ADJUST</MenuItem>
//                     <MenuItem value="BILL">BILL</MenuItem>
//                     <MenuItem value="RETURN">RETURN</MenuItem>
//                     <MenuItem value="EXCHANGE_IN">EXCHANGE_IN</MenuItem>
//                     <MenuItem value="EXCHANGE_OUT">EXCHANGE_OUT</MenuItem>
//                   </TextField>
//                 </>
//               )}
//             </Stack>

//             <Button variant="outlined" onClick={downloadCSV} disabled={exportDisabled}>
//               Export CSV
//             </Button>
//           </Stack>

//           {tab === 'stock' && pickedItem && (
//             <Box mt={1} color="text.secondary">
//               Current Stock: <b>{qLedger.data?.pages?.[0]?.current_stock ?? pickedItem.stock ?? '-'}</b>
//             </Box>
//           )}
//         </Paper>

//         <Paper sx={{ p: 2 }}>
//           {tab === 'sales' && viewMode === 'aggregate' ? (
//             <Box sx={{ overflowX: 'auto' }}>
//               <table className="table">
//                 <thead>
//                   <tr>
//                     <th>{groupBy === 'day' ? 'Date' : 'Month'}</th>
//                     <th>Bills</th>
//                     <th>Gross Sales</th>
//                     <th>Paid</th>
//                     <th>Pending</th>
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {aggRows.map((x: any) => (
//                     <tr key={x.period}>
//                       <td>{x.period}</td>
//                       <td>{x.bills_count}</td>
//                       <td>{money(x.gross_sales)}</td>
//                       <td>{money(x.paid_total)}</td>
//                       <td>{money(x.pending_total)}</td>
//                     </tr>
//                   ))}
//                   {aggRows.length === 0 && !isLoading && (
//                     <tr>
//                       <td colSpan={5}>
//                         <Box p={2} color="text.secondary">
//                           No data.
//                         </Box>
//                       </td>
//                     </tr>
//                   )}
//                 </tbody>
//               </table>
//             </Box>
//           ) : tab === 'stock' ? (
//             <Box sx={{ overflowX: 'auto' }}>
//               <table className="table">
//                 <thead>
//                   <tr>
//                     <th>ID</th>
//                     <th>TS</th>
//                     <th>Delta</th>
//                     <th>Reason</th>
//                     <th>Ref</th>
//                     <th>Before</th>
//                     <th>After</th>
//                     <th>Note</th>
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {!pickedItem ? (
//                     <tr>
//                       <td colSpan={8}>
//                         <Box p={2} color="text.secondary">
//                           Pick an item to view ledger.
//                         </Box>
//                       </td>
//                     </tr>
//                   ) : (
//                     (detailRows as any[]).map((r: any) => (
//                       <tr key={`m-${r.id}`}>
//                         <td>{r.id}</td>
//                         <td>{r.ts}</td>
//                         <td>{r.delta}</td>
//                         <td>{r.reason}</td>
//                         <td>{r.ref_type ? `${r.ref_type}${r.ref_id ? ` #${r.ref_id}` : ''}` : '-'}</td>
//                         <td>{r.before}</td>
//                         <td>{r.after}</td>
//                         <td>{r.note || '-'}</td>
//                       </tr>
//                     ))
//                   )}

//                   {pickedItem && (detailRows as any[]).length === 0 && !isLoading && (
//                     <tr>
//                       <td colSpan={8}>
//                         <Box p={2} color="text.secondary">
//                           No ledger rows for this date range.
//                         </Box>
//                       </td>
//                     </tr>
//                   )}
//                 </tbody>
//               </table>
//             </Box>
//           ) : (
//             <Box sx={{ overflowX: 'auto' }}>
//               <table className="table">
//                 <thead>
//                   {tab === 'sales' ? (
//                     <tr>
//                       <th>Bill ID</th>
//                       <th>Date/Time</th>
//                       <th>Items</th>
//                       <th>Subtotal</th>
//                       <th>Discount</th>
//                       <th>Tax</th>
//                       <th>Total</th>
//                       <th>Paid</th>
//                       <th>Pending</th>
//                       <th>Status</th>
//                       <th>Mode</th>
//                     </tr>
//                   ) : (
//                     <tr>
//                       <th>Return ID</th>
//                       <th>Date/Time</th>
//                       <th>Lines</th>
//                       <th>Refund</th>
//                       <th>Notes</th>
//                     </tr>
//                   )}
//                 </thead>

//                 <tbody>
//                   {(detailRows as any[]).map((r: any) =>
//                     tab === 'sales' ? (
//                       <tr key={`b-${r.id}`}>
//                         <td>
//                           <Tooltip title={r.itemsPreview} arrow placement="top">
//                             <Link component="button" onClick={() => openDetail(r)} underline="hover">
//                               {r.id}
//                             </Link>
//                           </Tooltip>
//                         </td>
//                         <td>{r.date}</td>
//                         <td>{r.itemsCount}</td>
//                         <td>{r.subtotal}</td>
//                         <td>{r.discount}</td>
//                         <td>{r.tax}</td>
//                         <td>{r.total}</td>
//                         <td>{r.paid}</td>
//                         <td>{r.pending}</td>
//                         <td>{r.status}</td>
//                         <td>{r.mode}</td>
//                       </tr>
//                     ) : (
//                       <tr key={`r-${r.id}`}>
//                         <td>
//                           <Tooltip title={r.itemsPreview} arrow placement="top">
//                             <Link component="button" onClick={() => openDetail(r)} underline="hover">
//                               {r.id}
//                             </Link>
//                           </Tooltip>
//                         </td>
//                         <td>{r.date}</td>
//                         <td>{r.linesCount}</td>
//                         <td>{r.refund}</td>
//                         <td>{r.notes}</td>
//                       </tr>
//                     )
//                   )}

//                   {(detailRows as any[]).length === 0 && !isLoading && (
//                     <tr>
//                       <td colSpan={tab === 'sales' ? 11 : 5}>
//                         <Box p={2} color="text.secondary">
//                           No data.
//                         </Box>
//                       </td>
//                     </tr>
//                   )}
//                 </tbody>
//               </table>
//             </Box>
//           )}

//           {/* status lines */}
//           {isLoading && (
//             <Box sx={{ py: 2, textAlign: 'center' }}>
//               <Typography variant="body2">Loading…</Typography>
//             </Box>
//           )}

//           {isError && (
//             <Box sx={{ py: 2, textAlign: 'center' }}>
//               <Typography variant="body2" color="error">
//                 Failed to load.
//               </Typography>
//             </Box>
//           )}

//           {/* infinite scroll only for sales details and stock */}
//           {((tab === 'sales' && viewMode === 'details') || (tab === 'stock' && !!pickedItem?.id)) && (
//             <>
//               <div ref={loadMoreRef} style={{ height: 1 }} />

//               {activeIsFetchingNextPage && (
//                 <Box sx={{ py: 2, textAlign: 'center' }}>
//                   <Typography variant="body2">Loading more…</Typography>
//                 </Box>
//               )}

//               {!activeHasNextPage && (detailRows as any[]).length > 0 && (
//                 <Box sx={{ py: 2, textAlign: 'center' }}>
//                   <Typography variant="body2">End of list</Typography>
//                 </Box>
//               )}
//             </>
//           )}
//         </Paper>
//       </Stack>

//       {/* Detail dialog (Sales/Returns only) */}
//       <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
//         <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
//           {detailType === 'bill' ? 'Bill Details' : 'Return Details'}
//           <IconButton onClick={() => setOpen(false)} size="small">
//             <CloseIcon />
//           </IconButton>
//         </DialogTitle>

//         <DialogContent dividers>
//           {!detail ? (
//             <Typography color="text.secondary">Loading…</Typography>
//           ) : (
//             <Stack gap={2}>
//               <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
//                 <Typography variant="subtitle1">
//                   ID: <b>{detail.id}</b>
//                 </Typography>
//                 <Typography variant="subtitle1">
//                   Date/Time: <b>{detail.date_time || detail.created_at || '-'}</b>
//                 </Typography>
//               </Stack>

//               <Divider />

//               <Box sx={{ overflowX: 'auto' }}>
//                 <table className="table">
//                   <thead>
//                     <tr>
//                       <th style={{ minWidth: 220 }}>Item</th>
//                       <th>Qty</th>
//                       <th>MRP</th>
//                       <th>Line Total</th>
//                     </tr>
//                   </thead>
//                   <tbody>
//                     {(detail.items || []).map((it: any, idx: number) => {
//                       const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
//                       const qty = Number(it.quantity)
//                       const mrp = Number(it.mrp)
//                       return (
//                         <tr key={idx}>
//                           <td>{name}</td>
//                           <td>{qty}</td>
//                           <td>{money(mrp)}</td>
//                           <td>{money(qty * mrp)}</td>
//                         </tr>
//                       )
//                     })}

//                     {(detail.items || []).length === 0 && (
//                       <tr>
//                         <td colSpan={4}>
//                           <Box p={2} color="text.secondary">
//                             No items.
//                           </Box>
//                         </td>
//                       </tr>
//                     )}
//                   </tbody>
//                 </table>
//               </Box>

//               {detailType === 'bill' ? (
//                 <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 420 }}>
//                   <Typography>
//                     Total: <b>{money(detail.total_amount || 0)}</b>
//                   </Typography>
//                   <Typography>
//                     Payment Mode: <b>{detail.payment_mode || '-'}</b>
//                   </Typography>
//                   <Typography>
//                     Payment Status:{' '}
//                     <b>{detail.payment_status || (detail.is_credit ? 'UNPAID' : 'PAID')}</b>
//                   </Typography>
//                   <Typography>
//                     Paid Amount: <b>{money(detail.paid_amount || 0)}</b>
//                   </Typography>
//                   <Typography>
//                     Pending Amount:{' '}
//                     <b>
//                       {money(
//                         Math.max(0, Number(detail.total_amount || 0) - Number(detail.paid_amount || 0))
//                       )}
//                     </b>
//                   </Typography>
//                   {detail.notes ? (
//                     <Typography sx={{ mt: 1 }}>
//                       Notes: <i>{detail.notes}</i>
//                     </Typography>
//                   ) : null}
//                 </Stack>
//               ) : (
//                 <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 360 }}>
//                   <Typography>
//                     Refund:{' '}
//                     <b>
//                       {money(
//                         detail.subtotal_return ??
//                           (detail.items || []).reduce(
//                             (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
//                             0
//                           )
//                       )}
//                     </b>
//                   </Typography>
//                   {detail.notes ? (
//                     <Typography sx={{ mt: 1 }}>
//                       Notes: <i>{detail.notes}</i>
//                     </Typography>
//                   ) : null}
//                 </Stack>
//               )}
//             </Stack>
//           )}
//         </DialogContent>
//       </Dialog>

//       {/* ✅ Item picker dialog (Stock Ledger) */}
//       <Dialog open={itemPickerOpen} onClose={() => setItemPickerOpen(false)} fullWidth maxWidth="sm">
//         <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
//           Pick Item
//           <IconButton onClick={() => setItemPickerOpen(false)} size="small">
//             <CloseIcon />
//           </IconButton>
//         </DialogTitle>

//         <DialogContent dividers>
//           <Stack gap={2}>
//             <TextField
//               label="Search item (name/brand)"
//               value={itemSearch}
//               onChange={(e) => setItemSearch(e.target.value)}
//               fullWidth
//             />

//             <Divider />

//             <Box sx={{ overflowX: 'auto' }}>
//               <table className="table">
//                 <thead>
//                   <tr>
//                     <th>ID</th>
//                     <th>Name</th>
//                     <th>Brand</th>
//                     <th>Stock</th>
//                     <th></th>
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {qItemSearch.isLoading && (
//                     <tr>
//                       <td colSpan={5}>
//                         <Box p={2} color="text.secondary">
//                           Loading…
//                         </Box>
//                       </td>
//                     </tr>
//                   )}

//                   {!qItemSearch.isLoading && (qItemSearch.data || []).length === 0 && debouncedItemSearch && (
//                     <tr>
//                       <td colSpan={5}>
//                         <Box p={2} color="text.secondary">
//                           No items found.
//                         </Box>
//                       </td>
//                     </tr>
//                   )}

//                   {(qItemSearch.data || []).slice(0, 50).map((it: any) => (
//                     <tr key={it.id}>
//                       <td>{it.id}</td>
//                       <td>{it.name}</td>
//                       <td>{it.brand || '-'}</td>
//                       <td>{it.stock}</td>
//                       <td style={{ width: 100 }}>
//                         <Button
//                           size="small"
//                           variant="contained"
//                           onClick={() => {
//                             setPickedItem(it)
//                             setItemPickerOpen(false)
//                           }}
//                         >
//                           Pick
//                         </Button>
//                       </td>
//                     </tr>
//                   ))}

//                   {!debouncedItemSearch && (
//                     <tr>
//                       <td colSpan={5}>
//                         <Box p={2} color="text.secondary">
//                           Type to search items.
//                         </Box>
//                       </td>
//                     </tr>
//                   )}
//                 </tbody>
//               </table>
//             </Box>

//             <Typography variant="body2" color="text.secondary">
//               Tip: Pick the correct item batch if you have duplicates (same name/brand with different expiry).
//             </Typography>
//           </Stack>
//         </DialogContent>
//       </Dialog>
//     </>
//   )
// }
