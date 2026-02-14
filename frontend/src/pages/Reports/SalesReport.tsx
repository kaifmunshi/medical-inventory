import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
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
import EditIcon from '@mui/icons-material/Edit'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from '../../components/ui/Toaster'
import { listItems } from '../../services/inventory'

import { listBillsPaged, getBill, getSalesAggregate, softDeleteBill, recoverBill, updateBill } from '../../services/billing'

type ViewMode = 'details' | 'aggregate'
type GroupBy = 'day' | 'month'
type DeletedFilter = 'active' | 'deleted' | 'all'
type EditMode = 'cash' | 'online' | 'split' | 'credit'

type EditLine = {
  item_id: number
  item_name: string
  mrp: number
  quantity: number
  custom_unit_price: number
  item_discount_percent: number
  stock?: number
  existed_in_bill?: boolean
}

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

function parseNumText(v: string): number | '' {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const n = Number(s)
  return Number.isFinite(n) ? n : ''
}

function blurOnWheel(e: any) {
  e.currentTarget.blur()
}

const GRID_INPUT_SX = {
  '& .MuiInputBase-root': {
    height: 38,
  },
} as const

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
  deletedFilter: DeletedFilter
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
}) {
  const { from, to, q, viewMode, groupBy, deletedFilter, setExportFn, setExportDisabled } = props
  const toast = useToast()
  const queryClient = useQueryClient()

  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const LIMIT = 30

  // Detail dialog
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<any | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editBillId, setEditBillId] = useState<number | null>(null)
  const [editItems, setEditItems] = useState<EditLine[]>([])
  const [editPaymentMode, setEditPaymentMode] = useState<EditMode>('cash')
  const [editSplitCombination, setEditSplitCombination] = useState<
    'cash-online' | 'cash-credit' | 'online-credit'
  >('cash-online')
  const [editCash, setEditCash] = useState<number>(0)
  const [editOnline, setEditOnline] = useState<number>(0)
  const [editNotes, setEditNotes] = useState<string>('')
  const [editFinalAmount, setEditFinalAmount] = useState<number>(0)
  const [editFinalManuallyEdited, setEditFinalManuallyEdited] = useState(false)
  const [editItemQuery, setEditItemQuery] = useState('')
  const [editPriceDraftByRow, setEditPriceDraftByRow] = useState<Record<number, string>>({})
  const [editDiscountDraftByRow, setEditDiscountDraftByRow] = useState<Record<number, string>>({})
  const [editSuggestionPage, setEditSuggestionPage] = useState(0)

  const qEditItems = useQuery({
    queryKey: ['edit-bill-items', editItemQuery],
    enabled: editOpen,
    queryFn: () => listItems(editItemQuery),
  })

  const EDIT_SUGGESTIONS_PAGE_SIZE = 8
  const editSuggestionItems = (qEditItems.data || []) as any[]
  const editSuggestionTotalPages = Math.max(
    1,
    Math.ceil(editSuggestionItems.length / EDIT_SUGGESTIONS_PAGE_SIZE)
  )
  const editSuggestionPageClamped = Math.min(editSuggestionPage, editSuggestionTotalPages - 1)
  const editSuggestionStart = editSuggestionPageClamped * EDIT_SUGGESTIONS_PAGE_SIZE
  const editSuggestionVisible = editSuggestionItems.slice(
    editSuggestionStart,
    editSuggestionStart + EDIT_SUGGESTIONS_PAGE_SIZE
  )

  useEffect(() => {
    setEditSuggestionPage(0)
  }, [editItemQuery, editOpen])

  // SALES DETAILS (paged)
  const qSales = useInfiniteQuery({
    queryKey: ['rpt-sales', 'details', from, to, debouncedQ, deletedFilter],
    enabled: viewMode === 'details',
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      return await listBillsPaged({
        from_date: from,
        to_date: to,
        q: debouncedQ,
        deleted_filter: deletedFilter,
        limit: LIMIT,
        offset: pageParam,
      })
    },
    getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
  })

  // SALES AGGREGATE
  const qAgg = useQuery({
    queryKey: ['rpt-sales', 'aggregate', from, to, groupBy, deletedFilter],
    enabled: viewMode === 'aggregate',
    queryFn: () =>
      getSalesAggregate({
        from_date: from,
        to_date: to,
        group_by: groupBy,
        deleted_filter: deletedFilter,
      }),
  })

  const mSoftDelete = useMutation({
    mutationFn: softDeleteBill,
    onSuccess: async (_data, billId) => {
      toast.push(`Bill #${billId} deleted`, 'warning')
      await qSales.refetch()
      if (detail?.id === billId) {
        try {
          const b = await getBill(billId)
          setDetail(b)
        } catch {}
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to delete bill'
      toast.push(String(msg), 'error')
    },
  })

  const mRecover = useMutation({
    mutationFn: recoverBill,
    onSuccess: async (_data, billId) => {
      toast.push(`Bill #${billId} recovered`, 'success')
      await qSales.refetch()
      if (detail?.id === billId) {
        try {
          const b = await getBill(billId)
          setDetail(b)
        } catch {}
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to recover bill'
      toast.push(String(msg), 'error')
    },
  })

  const mEdit = useMutation({
    mutationFn: async () => {
      if (!editBillId) throw new Error('Bill not selected')
      if (editPaymentMode === 'credit' && editNotes.trim().length === 0) {
        throw new Error('Notes required for credit')
      }
      const cleanedItems = editItems
        .map((it) => ({
          item_id: Number(it.item_id),
          quantity: Number(it.quantity || 0),
          custom_unit_price: Number(it.custom_unit_price || it.mrp || 0),
        }))
        .filter((it) => it.quantity > 0)
      if (cleanedItems.length === 0) throw new Error('At least one item quantity must be > 0')

      const payload: any = {
        items: cleanedItems,
        discount_percent: 0,
        payment_mode: editPaymentMode,
        payment_cash: Number(editCash || 0),
        payment_online: Number(editOnline || 0),
        final_amount: editChosenFinal,
        notes: editNotes || undefined,
      }

      if (editPaymentMode === 'credit') {
        payload.payment_cash = 0
        payload.payment_online = 0
      } else if (editPaymentMode === 'cash') {
        payload.payment_cash = editChosenFinal
        payload.payment_online = 0
      } else if (editPaymentMode === 'online') {
        payload.payment_cash = 0
        payload.payment_online = editChosenFinal
      } else if (editSplitCombination === 'cash-online') {
        const sum = round2(Number(payload.payment_cash || 0) + Number(payload.payment_online || 0))
        if (sum !== editChosenFinal) {
          throw new Error(`Cash + Online must equal Final Amount (₹${money(editChosenFinal)})`)
        }
      } else if (editSplitCombination === 'cash-credit') {
        payload.payment_online = 0
        payload.payment_credit = round2(editChosenFinal - Number(payload.payment_cash || 0))
        if (payload.payment_credit < 0) throw new Error('Cash amount cannot be greater than final amount')
      } else {
        payload.payment_cash = 0
        payload.payment_credit = round2(editChosenFinal - Number(payload.payment_online || 0))
        if (payload.payment_credit < 0) throw new Error('Online amount cannot be greater than final amount')
      }

      return updateBill(editBillId, payload)
    },
    onSuccess: async (updated) => {
      toast.push(`Bill #${updated.id} updated`, 'success')
      setEditOpen(false)
      queryClient.setQueryData(
        ['rpt-sales', 'details', from, to, debouncedQ, deletedFilter],
        (old: any) => {
          if (!old?.pages) return old
          return {
            ...old,
            pages: old.pages.map((p: any) => ({
              ...p,
              items: Array.isArray(p?.items)
                ? p.items.map((it: any) => (Number(it.id) === Number(updated.id) ? updated : it))
                : p?.items,
            })),
          }
        }
      )
      await qSales.refetch()
      if (detail?.id === updated.id) {
        setDetail(updated)
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to edit bill'
      toast.push(String(msg), 'error')
    },
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
        isDeleted: Boolean(b.is_deleted),
        deletedAt: b.deleted_at || '',
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

  function handleDelete(row: any) {
    if (!row?.id || row?.isDeleted) return
    const ok = window.confirm(`Delete bill #${row.id}? This is a soft delete and can be recovered.`)
    if (!ok) return
    mSoftDelete.mutate(Number(row.id))
  }

  function handleRecover(row: any) {
    if (!row?.id || !row?.isDeleted) return
    const ok = window.confirm(`Recover bill #${row.id}?`)
    if (!ok) return
    mRecover.mutate(Number(row.id))
  }

  function openEdit(row: any) {
    if (row?.isDeleted) {
      toast.push('Deleted bill cannot be edited', 'warning')
      return
    }
    const b = row?.raw || detail
    if (!b?.id) return
    const lines: EditLine[] = (b.items || []).map((it: any) => ({
      item_id: Number(it.item_id),
      item_name: String(it.item_name || it.name || `#${it.item_id}`),
      mrp: Number(it.mrp || 0),
      quantity: Number(it.quantity || 0),
      custom_unit_price: Number(it.mrp || 0),
      item_discount_percent: 0,
      existed_in_bill: true,
    }))
    setEditBillId(Number(b.id))
    setEditItems(lines)
    setEditPaymentMode((b.payment_mode || 'cash') as EditMode)
    setEditSplitCombination('cash-online')
    setEditCash(Number(b.payment_cash || 0))
    setEditOnline(Number(b.payment_online || 0))
    setEditNotes(String(b.notes || ''))
    const sumByRows = round2(lines.reduce((s, it) => s + Number(it.custom_unit_price || 0) * Number(it.quantity || 0), 0))
    const billedTotal = Number.isFinite(Number(b.total_amount)) ? Number(b.total_amount) : sumByRows
    setEditFinalAmount(billedTotal)
    setEditFinalManuallyEdited(Math.abs(round2(billedTotal - sumByRows)) > 0.009)
    setEditItemQuery('')
    setEditPriceDraftByRow({})
    setEditDiscountDraftByRow({})
    setEditSuggestionPage(0)
    setEditOpen(true)
  }

  function addItemToEdit(it: any) {
    const itemId = Number(it.id)
    if (!itemId) return
    setEditPriceDraftByRow({})
    setEditItems((prev) => {
      const ix = prev.findIndex((x) => Number(x.item_id) === itemId)
      if (ix >= 0) {
        return prev.map((x, i) => (i === ix ? { ...x, quantity: Number(x.quantity || 0) + 1 } : x))
      }
      return [
        ...prev,
        {
          item_id: itemId,
          item_name: String(it.name || `#${itemId}`),
          mrp: Number(it.mrp || 0),
          quantity: 1,
          custom_unit_price: Number(it.mrp || 0),
          item_discount_percent: 0,
          stock: Number(it.stock || 0),
          existed_in_bill: false,
        },
      ]
    })
  }

  function removeEditItem(idx: number) {
    const row = editItems[idx]
    if (!row) return
    if (row.existed_in_bill) {
      const ok = window.confirm(`Remove existing bill item "${row.item_name}"?`)
      if (!ok) return
    }
    setEditPriceDraftByRow({})
    setEditDiscountDraftByRow({})
    setEditItems((prev) => prev.filter((_, i) => i !== idx))
  }

  function setEditUnitPrice(idx: number, v: number) {
    const n = Math.max(0, Number(v) || 0)
    setEditItems((prev) =>
      prev.map((x, i) => {
        if (i !== idx) return x
        const nextPrice = Number(n.toFixed(2))
        const base = Number(x.mrp || 0)
        const pct = base > 0 ? ((base - nextPrice) / base) * 100 : 0
        return {
          ...x,
          custom_unit_price: nextPrice,
          item_discount_percent: Number(Math.min(100, Math.max(0, pct)).toFixed(2)),
        }
      })
    )
  }

  function handleEditCustomPriceChange(idx: number, raw: string) {
    setEditPriceDraftByRow((prev) => ({ ...prev, [idx]: raw }))
  }

  function commitEditCustomPrice(idx: number) {
    const raw = String(editPriceDraftByRow[idx] ?? '').trim()
    if (raw === '') {
      setEditPriceDraftByRow((prev) => {
        const next = { ...prev }
        delete next[idx]
        return next
      })
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setEditPriceDraftByRow((prev) => {
        const next = { ...prev }
        delete next[idx]
        return next
      })
      return
    }
    const safe = Math.max(0, parsed)
    setEditUnitPrice(idx, safe)
    setEditPriceDraftByRow((prev) => {
      const next = { ...prev }
      delete next[idx]
      return next
    })
  }

  function setEditItemDiscountPercent(idx: number, v: number) {
    setEditItems((prev) =>
      prev.map((x, i) => {
        if (i !== idx) return x
        const base = Number(x.mrp || 0)
        const safePct = Math.min(100, Math.max(0, Number(v) || 0))
        const nextPrice = base > 0 ? base * (1 - safePct / 100) : 0
        return {
          ...x,
          item_discount_percent: Number(safePct.toFixed(2)),
          custom_unit_price: Number(nextPrice.toFixed(2)),
        }
      })
    )
  }

  function handleEditDiscountChange(idx: number, raw: string) {
    setEditDiscountDraftByRow((prev) => ({ ...prev, [idx]: raw }))
  }

  function commitEditDiscount(idx: number) {
    const raw = String(editDiscountDraftByRow[idx] ?? '').trim()
    if (raw === '') {
      setEditDiscountDraftByRow((prev) => {
        const next = { ...prev }
        delete next[idx]
        return next
      })
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setEditDiscountDraftByRow((prev) => {
        const next = { ...prev }
        delete next[idx]
        return next
      })
      return
    }
    setEditItemDiscountPercent(idx, parsed)
    setEditDiscountDraftByRow((prev) => {
      const next = { ...prev }
      delete next[idx]
      return next
    })
  }

  const editSubtotal = useMemo(
    () => round2(editItems.reduce((s, it) => s + Number(it.mrp || 0) * Number(it.quantity || 0), 0)),
    [editItems]
  )

  const editFinalByRows = useMemo(
    () => round2(editItems.reduce((s, it) => s + Number(it.custom_unit_price || 0) * Number(it.quantity || 0), 0)),
    [editItems]
  )

  useEffect(() => {
    if (!editOpen) return
    if (!editFinalManuallyEdited) {
      setEditFinalAmount(editFinalByRows)
    }
  }, [editOpen, editFinalByRows, editFinalManuallyEdited])

  const editChosenFinal = round2(Number(editFinalAmount || 0))

  const editDiscountAmount = useMemo(() => Math.max(0, round2(editSubtotal - editFinalByRows)), [editSubtotal, editFinalByRows])
  const editEffectiveDiscountPercent = useMemo(() => (editSubtotal > 0 ? (editDiscountAmount / editSubtotal) * 100 : 0), [editSubtotal, editDiscountAmount])
  const editSplitCreditAmount = useMemo(
    () =>
      round2(
        editSplitCombination === 'cash-credit'
          ? editChosenFinal - Number(editCash || 0)
          : editSplitCombination === 'online-credit'
            ? editChosenFinal - Number(editOnline || 0)
            : 0
      ),
    [editSplitCombination, editChosenFinal, editCash, editOnline]
  )
  const editPaymentsOk = useMemo(() => {
    const c = Number(editCash || 0)
    const o = Number(editOnline || 0)
    if (editPaymentMode === 'credit') return true
    if (editPaymentMode === 'cash') return round2(c) === round2(editChosenFinal)
    if (editPaymentMode === 'online') return round2(o) === round2(editChosenFinal)
    if (editSplitCombination === 'cash-online') return round2(c + o) === round2(editChosenFinal)
    if (editSplitCombination === 'cash-credit') return c >= 0 && c <= editChosenFinal
    return o >= 0 && o <= editChosenFinal
  }, [editPaymentMode, editCash, editOnline, editChosenFinal, editSplitCombination])
  const editNotesOkForCredit = editPaymentMode !== 'credit' || editNotes.trim().length > 0

  function roundNearest10(x: number) {
    return Math.round(x / 10) * 10
  }
  function roundUp10(x: number) {
    return Math.ceil(x / 10) * 10
  }
  function roundDown10(x: number) {
    return Math.floor(x / 10) * 10
  }

  useEffect(() => {
    if (!editOpen) return
    if (editPaymentMode === 'credit') {
      setEditCash(0)
      setEditOnline(0)
      return
    }
    if (editPaymentMode === 'cash') {
      setEditCash(editChosenFinal)
      setEditOnline(0)
      return
    }
    if (editPaymentMode === 'online') {
      setEditCash(0)
      setEditOnline(editChosenFinal)
      return
    }
  }, [editOpen, editPaymentMode, editChosenFinal])

  const noSpinnerSx = {
    '& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button': {
      WebkitAppearance: 'none',
      margin: 0,
    },
    '& input[type=number]': {
      MozAppearance: 'textfield',
    },
  } as const

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
        'Deleted',
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
        r.isDeleted ? 'YES' : 'NO',
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
                  <th>Deleted</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {detailRows.map((r: any) => (
                  <tr
                    key={`b-${r.id}`}
                    onDoubleClick={() => openEdit(r)}
                    style={r.isDeleted ? { backgroundColor: '#ffe9e9' } : undefined}
                  >
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
                    <td>{r.isDeleted ? 'Yes' : 'No'}</td>
                    <td>
                      <Stack direction="row" gap={1}>
                        <Tooltip title="Edit bill" arrow>
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => openEdit(r)}
                              disabled={r.isDeleted}
                            >
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        {r.isDeleted ? (
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => handleRecover(r)}
                            disabled={mRecover.isPending}
                          >
                            Recover
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            color="error"
                            variant="outlined"
                            onClick={() => handleDelete(r)}
                            disabled={mSoftDelete.isPending}
                          >
                            Delete
                          </Button>
                        )}
                      </Stack>
                    </td>
                  </tr>
                ))}

                {detailRows.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={13}>
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
                  Deleted: <b>{detail.is_deleted ? 'Yes' : 'No'}</b>
                </Typography>
                {detail.is_deleted ? (
                  <Typography>
                    Deleted At: <b>{detail.deleted_at || '-'}</b>
                  </Typography>
                ) : null}
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
                {!detail.is_deleted ? (
                  <Box sx={{ pt: 1 }}>
                    <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => openEdit({ raw: detail })}>
                      Edit Bill
                    </Button>
                  </Box>
                ) : null}
              </Stack>
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        fullWidth
        maxWidth="xl"
        PaperProps={{ sx: { minHeight: '82vh' } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Edit Bill #{editBillId || ''}
          <IconButton onClick={() => setEditOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <Paper sx={{ p: 2 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
                <TextField
                  label="Add item (name/brand)"
                  value={editItemQuery}
                  onChange={(e) => setEditItemQuery(e.target.value)}
                  fullWidth
                />
                <Stack gap={0.5} sx={{ minWidth: 240 }}>
                  <Typography variant="body2" color="text.secondary">
                    Subtotal: ₹{money(editSubtotal)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Discount: ₹{money(editDiscountAmount)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Computed Total: ₹{money(editFinalByRows)}
                  </Typography>
                  <Typography variant="h6">Final Amount: ₹{money(editChosenFinal)}</Typography>
                </Stack>
              </Stack>

              <Box sx={{ mt: 1, maxHeight: 185, overflowY: 'auto', border: '1px solid #eee', borderRadius: 1, p: 1 }}>
                {editSuggestionVisible.map((it: any) => (
                  <Stack
                    key={`edit-add-${it.id}`}
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    sx={{
                      py: 0.5,
                      px: 0.75,
                      borderRadius: 1,
                      bgcolor: Number(it.stock || 0) <= 0 ? 'rgba(244, 67, 54, 0.12)' : 'transparent',
                    }}
                  >
                    <Box>
                      <Typography variant="body2">{it.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        Brand: {it.brand || '-'} | Stock: {Number(it.stock || 0)} | MRP: {money(it.mrp)}
                      </Typography>
                    </Box>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => addItemToEdit(it)}
                      disabled={Number(it.stock || 0) <= 0}
                    >
                      Add
                    </Button>
                  </Stack>
                ))}
                {editSuggestionItems.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No items found.
                  </Typography>
                ) : null}
              </Box>
              {editSuggestionItems.length > EDIT_SUGGESTIONS_PAGE_SIZE && (
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Showing {editSuggestionStart + 1}-
                    {Math.min(editSuggestionStart + EDIT_SUGGESTIONS_PAGE_SIZE, editSuggestionItems.length)} of{' '}
                    {editSuggestionItems.length}
                  </Typography>
                  <Stack direction="row" gap={1}>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => setEditSuggestionPage((p) => Math.max(0, p - 1))}
                      disabled={editSuggestionPageClamped <= 0}
                    >
                      Prev
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() =>
                        setEditSuggestionPage((p) => Math.min(editSuggestionTotalPages - 1, p + 1))
                      }
                      disabled={editSuggestionPageClamped >= editSuggestionTotalPages - 1}
                    >
                      Next
                    </Button>
                  </Stack>
                </Stack>
              )}
            </Paper>

            <Paper sx={{ p: 2 }}>
              <Box sx={{ overflowX: 'auto' }}>
                <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '42%' }}>Item</th>
                      <th style={{ width: '10%' }}>MRP</th>
                      <th style={{ width: '8%' }}>Qty</th>
                      <th style={{ width: '10%' }}>Discount %</th>
                      <th style={{ width: '12%' }}>Custom Price</th>
                      <th style={{ width: '12%' }}>Line Total</th>
                      <th style={{ width: '6%' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {editItems.map((it, idx) => (
                      <tr key={`${it.item_id}-${idx}`}>
                        <td>{it.item_name}</td>
                        <td>{money(it.mrp)}</td>
                        <td style={{ textAlign: 'center' }}>
                          <TextField
                            size="small"
                            type="number"
                            value={it.quantity}
                            onChange={(e) => {
                              const qty = Number(e.target.value || 0)
                              setEditItems((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, quantity: qty } : x))
                              )
                            }}
                            onWheel={blurOnWheel}
                            onFocus={(e) => e.target.select()}
                            sx={{ width: 72, ...GRID_INPUT_SX, ...noSpinnerSx }}
                            inputProps={{ min: 0, step: 1, inputMode: 'numeric' }}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <TextField
                            size="small"
                            type="text"
                            value={
                              Object.prototype.hasOwnProperty.call(editDiscountDraftByRow, idx)
                                ? editDiscountDraftByRow[idx]
                                : String(Number(it.item_discount_percent || 0).toFixed(2))
                            }
                            onChange={(e) => handleEditDiscountChange(idx, e.target.value)}
                            onBlur={() => commitEditDiscount(idx)}
                            onWheel={blurOnWheel}
                            onFocus={(e) => e.target.select()}
                            sx={{ width: 96, ...GRID_INPUT_SX, ...noSpinnerSx }}
                            inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <TextField
                            size="small"
                            type="text"
                            value={
                              Object.prototype.hasOwnProperty.call(editPriceDraftByRow, idx)
                                ? editPriceDraftByRow[idx]
                                : String(Number(it.custom_unit_price || 0).toFixed(2))
                            }
                            onChange={(e) => handleEditCustomPriceChange(idx, e.target.value)}
                            onBlur={() => commitEditCustomPrice(idx)}
                            onWheel={blurOnWheel}
                            onFocus={(e) => e.target.select()}
                            sx={{ width: 108, ...GRID_INPUT_SX, ...noSpinnerSx }}
                            inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
                          />
                        </td>
                        <td>{money(Number(it.custom_unit_price || 0) * Number(it.quantity || 0))}</td>
                        <td>
                          <Button size="small" color="error" onClick={() => removeEditItem(idx)}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            </Paper>

            <Paper sx={{ p: 2 }}>
              <Stack gap={2}>
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} flexWrap="wrap" useFlexGap>
                  <TextField
                    select
                    label="Payment Mode"
                    value={editPaymentMode}
                    onChange={(e) => {
                      const v = e.target.value as EditMode
                      setEditPaymentMode(v)
                      if (v === 'credit') {
                        setEditCash(0)
                        setEditOnline(0)
                      }
                    }}
                    sx={{ width: 170 }}
                  >
                    <MenuItem value="cash">Cash</MenuItem>
                    <MenuItem value="online">Online</MenuItem>
                    <MenuItem value="split">Split</MenuItem>
                    <MenuItem value="credit">Credit</MenuItem>
                  </TextField>

                  {editPaymentMode === 'split' && (
                    <TextField
                      select
                      label="Split Combination"
                      value={editSplitCombination}
                      onChange={(e) => {
                        const v = e.target.value as 'cash-online' | 'cash-credit' | 'online-credit'
                        setEditSplitCombination(v)
                        if (v === 'cash-credit') setEditOnline(0)
                        if (v === 'online-credit') setEditCash(0)
                      }}
                      sx={{ width: 230 }}
                    >
                      <MenuItem value="cash-online">Cash + Online</MenuItem>
                      <MenuItem value="cash-credit">Cash + Credit</MenuItem>
                      <MenuItem value="online-credit">Online + Credit</MenuItem>
                    </TextField>
                  )}
                </Stack>

                <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} flexWrap="wrap" useFlexGap>
                  {(editPaymentMode === 'cash' ||
                    (editPaymentMode === 'split' && editSplitCombination !== 'online-credit')) && (
                    <TextField
                      label="Cash Amount"
                      type="text"
                      value={String(editCash)}
                      onChange={(e) => setEditCash(Number(parseNumText(e.target.value) || 0))}
                      onWheel={blurOnWheel}
                      sx={{ width: 170, ...noSpinnerSx }}
                      inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
                    />
                  )}

                  {(editPaymentMode === 'online' ||
                    (editPaymentMode === 'split' && editSplitCombination !== 'cash-credit')) && (
                    <TextField
                      label="Online Amount"
                      type="text"
                      value={String(editOnline)}
                      onChange={(e) => setEditOnline(Number(parseNumText(e.target.value) || 0))}
                      onWheel={blurOnWheel}
                      sx={{ width: 170, ...noSpinnerSx }}
                      inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
                    />
                  )}
                  {editPaymentMode === 'split' &&
                    (editSplitCombination === 'cash-credit' || editSplitCombination === 'online-credit') && (
                      <TextField
                        label="Credit Amount"
                        type="text"
                        value={money(Math.max(0, editSplitCreditAmount))}
                        sx={{ width: 170, ...noSpinnerSx }}
                        inputProps={{ inputMode: 'decimal' }}
                        disabled
                      />
                    )}
                </Stack>

                <Typography variant="caption" color="text.secondary">
                  Discount Given: +{editEffectiveDiscountPercent.toFixed(2)}%
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Final Amount (sum of line totals): ₹{money(editFinalByRows)}
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
                  <TextField
                    label="Final Amount (you charge)"
                    type="text"
                    value={String(editFinalAmount)}
                    onChange={(e) => {
                      const v = parseNumText(e.target.value)
                      setEditFinalAmount(Number(v || 0))
                      setEditFinalManuallyEdited(true)
                    }}
                    onWheel={blurOnWheel}
                    sx={{ width: 220, ...noSpinnerSx }}
                    inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
                  />
                  <Button
                    size="small"
                    onClick={() => {
                      setEditFinalAmount(roundNearest10(editFinalByRows))
                      setEditFinalManuallyEdited(true)
                    }}
                  >
                    Round ±10
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditFinalAmount(roundDown10(editFinalByRows))
                      setEditFinalManuallyEdited(true)
                    }}
                  >
                    Round ↓10
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditFinalAmount(roundUp10(editFinalByRows))
                      setEditFinalManuallyEdited(true)
                    }}
                  >
                    Round ↑10
                  </Button>
                </Stack>
              </Stack>
            </Paper>

            <TextField
              label={editPaymentMode === 'credit' ? 'Notes (Required for Credit)' : 'Notes'}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              fullWidth
              multiline
              minRows={2}
              required={editPaymentMode === 'credit'}
              error={editPaymentMode === 'credit' && editNotes.trim().length === 0}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => mEdit.mutate()}
            disabled={mEdit.isPending || !editPaymentsOk || !editNotesOkForCredit}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
