// src/pages/Returns/Exchange.tsx
import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, TextField, Typography, IconButton, MenuItem } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import UndoIcon from '@mui/icons-material/Undo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { findBill, createExchange, getExchangeByReturn, getReturnHistory, getReturnSummary, listExchangeRecords, undoExchange, updateExchange, type ExchangeRecord } from '../../services/returns'
import { useSearchParams } from 'react-router-dom'
import ItemPicker, { type PickerItem } from '../../components/billing/ItemPicker'
import BillPickerDialog from '../../components/billing/BillPickerDialog'
import { useToast } from '../../components/ui/Toaster'

type RetRow = { item_id:number; name:string; brand?: string | null; qty:number; max:number; mrp:number; charged_unit_price?: number; remaining_value?: number; custom_return_value?: number | ''; editing_return_value?: boolean; loose_sale_enabled?: boolean; is_loose_stock?: boolean; conversion_qty?: number | null; child_unit_name?: string | null; opened_loose_quantity?: number }
type AddRow = { item_id:number; name:string; brand?: string | null; qty:number | ''; mrp:number; selling_price?: number | ''; available_stock?: number; inventory_lot_id?: number | null }

function round2(n:number){ return Math.round(n*100)/100 }
function asString(x:any){
  if (typeof x === 'string') return x
  try { return JSON.stringify(x, null, 2) } catch { return String(x) }
}

function exchangeAuditDetails(detailsJson?: string | null) {
  if (!detailsJson) return [] as string[]
  try {
    const details = JSON.parse(detailsJson)
    const before = details?.before || {}
    const after = details?.after || details || {}
    const changes: string[] = []
    const money = (value: any) => `₹${Number(value || 0).toFixed(2)}`
    const addChange = (label: string, oldValue: any, newValue: any, format = (value: any) => String(value ?? '—')) => {
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) changes.push(`${label}: ${format(oldValue)} → ${format(newValue)}`)
    }
    addChange('Date', before.date, after.date, (value) => String(value || '').slice(0, 10))
    addChange('Return total', before.return_value, after.return_value, money)
    addChange('Replacement total', before.replacement_total, after.replacement_total, money)
    addChange('Discount', before.discount_percent, after.discount_percent, (value) => `${Number(value || 0)}%`)
    addChange('Net settlement', before.net_due, after.net_due, money)
    addChange('Payment mode', before.payment_mode, after.payment_mode, (value) => String(value || '—').toUpperCase())

    const compareProducts = (label: string, oldRows: any[] = [], newRows: any[] = [], isReplacement = false) => {
      const oldMap = new Map(oldRows.map((row) => [Number(row.item_id), row]))
      const newMap = new Map(newRows.map((row) => [Number(row.item_id), row]))
      for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
        const oldRow = oldMap.get(id); const newRow = newMap.get(id)
        const name = newRow?.name || oldRow?.name || `Item #${id}`
        if (!oldRow) { changes.push(`${label} added: ${name}, qty ${newRow.quantity}${isReplacement ? ` at ${money(newRow.selling_price)}` : `, value ${money(newRow.return_value)}`}`); continue }
        if (!newRow) { changes.push(`${label} removed: ${name}, qty ${oldRow.quantity}`); continue }
        if (Number(oldRow.quantity) !== Number(newRow.quantity)) changes.push(`${label} qty — ${name}: ${oldRow.quantity} → ${newRow.quantity}`)
        if (isReplacement && Number(oldRow.selling_price) !== Number(newRow.selling_price)) changes.push(`Selling price — ${name}: ${money(oldRow.selling_price)} → ${money(newRow.selling_price)}`)
        if (!isReplacement && Number(oldRow.return_value) !== Number(newRow.return_value)) changes.push(`Return value — ${name}: ${money(oldRow.return_value)} → ${money(newRow.return_value)}`)
        if (!isReplacement && Number(oldRow.opened_loose_quantity || 0) !== Number(newRow.opened_loose_quantity || 0)) changes.push(`Loose units — ${name}: ${oldRow.opened_loose_quantity || 0} → ${newRow.opened_loose_quantity || 0}`)
      }
    }
    compareProducts('Returned product', before.returned_products, after.returned_products)
    compareProducts('Exchange product', before.exchange_products, after.exchange_products, true)
    addChange('Cash payment', before.payment?.cash, after.payment?.cash, money)
    addChange('Online payment', before.payment?.online, after.payment?.online, money)
    addChange('Credit payment', before.payment?.credit, after.payment?.credit, money)
    addChange('Cash refund', before.refund?.cash, after.refund?.cash, money)
    addChange('Online refund', before.refund?.online, after.refund?.online, money)
    addChange('Credit refund', before.refund?.credit, after.refund?.credit, money)
    return changes
  } catch {
    return [] as string[]
  }
}

export default function Exchange() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const today = new Date().toLocaleDateString('en-CA')

  const [query, setQuery] = useState('')
  const [bill, setBill] = useState<any | null>(null)

  const [ret, setRet]   = useState<RetRow[]>([])
  const [add, setAdd]   = useState<AddRow[]>([])
  const [picker, setPicker] = useState(false)
  const [billPickerOpen, setBillPickerOpen] = useState(false)

  // Exchange discount on NEW items + final amount override
  const [exDiscount, setExDiscount] = useState(0)
  const [paymentMode, setPaymentMode] = useState<'cash' | 'online' | 'split' | 'credit'>('cash')
  const [paymentCashSplit, setPaymentCashSplit] = useState<number | ''>('')
  const [paymentOnlineSplit, setPaymentOnlineSplit] = useState<number | ''>('')
  const [paymentCreditSplit, setPaymentCreditSplit] = useState<number | ''>('')
  const [refundMode, setRefundMode] = useState<'cash' | 'online' | 'split' | 'credit'>('cash')
  const [exchangeDate, setExchangeDate] = useState(today)
  const [refundCashSplit, setRefundCashSplit] = useState<number | ''>('')
  const [refundOnlineSplit, setRefundOnlineSplit] = useState<number | ''>('')
  const [refundCreditSplit, setRefundCreditSplit] = useState<number | ''>('')
  const [historySearch, setHistorySearch] = useState('')
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [historySettlement, setHistorySettlement] = useState<'all' | 'cash' | 'online' | 'split' | 'credit'>('all')
  const [editExchange, setEditExchange] = useState<ExchangeRecord | null>(null)
  const [undoTarget, setUndoTarget] = useState<ExchangeRecord | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [releasedExchangeItems, setReleasedExchangeItems] = useState<PickerItem[]>([])
  const [releasedQtyByItemId, setReleasedQtyByItemId] = useState<Record<number, number>>({})

  const { refetch } = useQuery({
    queryKey: ['ex-bill', query],
    queryFn: () => findBill(query),
    enabled: false,
  })

  const history = useQuery({
    queryKey: ['exchange-history'],
    queryFn: async () => {
      const all = []
      const limit = 1000
      for (let offset = 0; ; offset += limit) {
        const page = await listExchangeRecords({ limit, offset })
        all.push(...page)
        if (page.length < limit) return all
      }
    },
  })

  const openExchangeHistory = useQuery({
    queryKey: ['exchange-audit-history', editExchange?.return_id],
    queryFn: () => getReturnHistory(Number(editExchange?.return_id)),
    enabled: Boolean(editExchange?.return_id),
  })

  const filteredHistory = useMemo(() => {
    const search = historySearch.trim().toLowerCase().replace(/^#/, '')
    return (history.data || []).filter((row) => {
      const date = String(row.created_at || '').slice(0, 10)
      if (historyFrom && date < historyFrom) return false
      if (historyTo && date > historyTo) return false
      if (historySettlement !== 'all' && row.payment_mode !== historySettlement) return false
      if (!search) return true
      return [row.id, row.source_bill_id, row.return_id, row.new_bill_id]
        .some((value) => value != null && String(value).toLowerCase().includes(search))
    })
  }, [history.data, historyFrom, historySearch, historySettlement, historyTo])

  const historyFiltersActive = Boolean(
    historySearch || historyFrom || historyTo || historySettlement !== 'all'
  )

  async function openExchangeEditor(row: ExchangeRecord) {
    const refundSide = Number(row.net_due || 0) < 0
    setEditLoading(true)
    try {
      const [details, summary, source] = await Promise.all([
        getExchangeByReturn(row.return_id),
        getReturnSummary(Number(row.source_bill_id || 0)),
        findBill(String(row.source_bill_id || '')),
      ])
      const sourceBill = Array.isArray(source) ? source[0] : source
      if (!sourceBill) throw new Error('Source bill could not be loaded')
      const remainingByItem = new Map((summary || []).map((item: any) => [Number(item.item_id), Number(item.remaining || 0)]))
      const currentQtyByItem = new Map((details.return?.items || []).map((item: any) => [Number(item.item_id), Number(item.quantity || 0)]))
      const currentReturnByItem = new Map((details.return?.items || []).map((item: any) => [Number(item.item_id), item]))
      setBill(sourceBill)
      setQuery(String(row.source_bill_id || ''))
      setRet((summary || []).map((item: any) => {
        const current: any = currentReturnByItem.get(Number(item.item_id))
        return {
          item_id: Number(item.item_id), name: item.item_name, brand: item.brand || null,
          qty: Number(current?.quantity || 0), max: Number(remainingByItem.get(Number(item.item_id)) || 0) + Number(currentQtyByItem.get(Number(item.item_id)) || 0),
          mrp: Number(item.mrp || 0), charged_unit_price: Number(item.charged_unit_price || 0) || undefined,
          remaining_value: Number(item.remaining_value || 0), custom_return_value: current ? Number(current.line_total || 0) : undefined,
          loose_sale_enabled: Boolean(item.loose_sale_enabled), is_loose_stock: Boolean(item.is_loose_stock),
          conversion_qty: Number(item.conversion_qty || 0) || null, child_unit_name: item.child_unit_name || null,
          opened_loose_quantity: Number(current?.opened_loose_quantity || 0) || undefined,
        }
      }))
      const originalReplacementItems = (details.bill?.items || []).map((item: any) => ({
        item_id: Number(item.item_id), name: item.item_name, brand: item.brand || null,
        qty: Number(item.quantity || 0), mrp: Number(item.mrp || 0), selling_price: Number(item.line_total || 0) / Math.max(1, Number(item.quantity || 0)),
        available_stock: Number(item.stock || 0) + Number(item.quantity || 0), inventory_lot_id: item.inventory_lot_id || null,
      }))
      setAdd(originalReplacementItems)
      setReleasedExchangeItems((details.bill?.items || []).map((item: any) => ({
        id: Number(item.item_id), name: item.item_name, brand: item.brand || null, mrp: Number(item.mrp || 0), stock: Number(item.stock || 0),
        expiry_date: item.expiry_date || null, inventory_lot_id: item.inventory_lot_id || null,
        opened_from_lot_id: item.opened_from_lot_id || null, is_loose_stock: Boolean(item.is_loose_stock),
        stock_unit_label: item.stock_unit_label || null, parent_unit_name: item.parent_unit_name || null,
        child_unit_name: item.child_unit_name || null, conversion_qty: item.conversion_qty || null,
        loose_sale_enabled: Boolean(item.loose_sale_enabled),
      })))
      setReleasedQtyByItemId(Object.fromEntries((details.bill?.items || []).map((item: any) => [Number(item.item_id), Number(item.quantity || 0)])))
      setExDiscount(Number(details.bill?.discount_percent || 0))
      setExchangeDate(String(row.created_at || '').slice(0, 10))
      const mode = row.payment_mode || 'cash'
      if (refundSide) {
        setRefundMode(mode)
        setRefundCashSplit(Number(row.refund_cash || 0)); setRefundOnlineSplit(Number(row.refund_online || 0)); setRefundCreditSplit(Number(row.refund_credit || 0))
      } else {
        setPaymentMode(mode)
        setPaymentCashSplit(Number(row.payment_cash || 0)); setPaymentOnlineSplit(Number(row.payment_online || 0)); setPaymentCreditSplit(Number(row.payment_credit || 0))
      }
      setEditExchange(row)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error: any) {
      toast.push(String(error?.response?.data?.detail || error?.message || 'Could not load exchange products'), 'error')
      setEditExchange(null)
    } finally {
      setEditLoading(false)
    }
  }

  useEffect(() => {
    const editId = Number(searchParams.get('edit') || 0)
    if (!editId || !history.data || editExchange) return
    const row = history.data.find((item) => Number(item.id) === editId)
    if (row) openExchangeEditor(row)
  }, [history.data, searchParams, editExchange])

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editExchange) throw new Error('No exchange selected')
      return updateExchange(editExchange.id, buildExchangePayload())
    },
    onSuccess: (result: any) => {
      toast.push(result?.unchanged ? 'No changes to save' : 'Exchange updated', result?.unchanged ? 'info' : 'success')
      setEditExchange(null)
      setBill(null); setRet([]); setAdd([]); setQuery('')
      setReleasedExchangeItems([]); setReleasedQtyByItemId({})
      setSearchParams({}, { replace: true })
      queryClient.invalidateQueries({ queryKey: ['exchange-history'] })
      queryClient.invalidateQueries({ queryKey: ['exchange-audit-history', editExchange?.return_id] })
      queryClient.invalidateQueries({ queryKey: ['customer-returns'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook'] })
      queryClient.invalidateQueries({ queryKey: ['billing'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['customer-ledger'] })
      // Exchange edits touch sales/returns books, ledgers, vouchers, credit,
      // dashboard totals, stock cards and reports. Refresh any mounted view.
      queryClient.invalidateQueries()
    },
    onError: (error: any) => toast.push(String(error?.response?.data?.detail || error?.message || 'Exchange update failed'), 'error'),
  })

  const undoMutation = useMutation({
    mutationFn: (id: number) => undoExchange(id),
    onSuccess: () => {
      toast.push('Exchange undone and stock restored', 'success')
      setUndoTarget(null)
      queryClient.invalidateQueries({ queryKey: ['exchange-history'] })
      queryClient.invalidateQueries({ queryKey: ['customer-returns'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries()
    },
    onError: (error: any) => toast.push(String(error?.response?.data?.detail || error?.message || 'Exchange could not be undone'), 'error'),
  })

  const clamp = (v:number, lo:number, hi:number) => Math.max(lo, Math.min(v, hi))
  const nameOf = (it:any) =>
    it?.item_name ?? it?.name ?? it?.item?.name ?? it?.item?.item_name ?? `#${it?.item_id ?? ''}`
  const brandOf = (it:any) => it?.brand ?? it?.item_brand ?? it?.item?.brand ?? null

  // ====== Load bill + remaining qty (like Returns) ======
  async function load() {
    const res = await refetch()
    let data = res.data
    if (!data) return

    if (Array.isArray(data)) {
      if (data.length === 0) {
        toast.push('No bill found', 'error')
        return
      }
      if (data.length === 1) {
        data = data[0]
      } else {
        setBillPickerOpen(true)
        return
      }
    }
    if ((data as any).is_deleted) {
      toast.push('Deleted bill cannot be used for exchange', 'error')
      return
    }

    setBill(data)

    const lines = (data?.items || []) as any[]

    let remById: Record<number, number> = {}
    let summaryById: Record<number, any> = {}
    try {
      const summary = await getReturnSummary(Number(data.id))
      summaryById = Object.fromEntries(
        (summary || []).map((s: any) => [Number(s.item_id), s])
      )
      remById = Object.fromEntries(
        (summary || []).map((s: any) => [Number(s.item_id), Number(s.remaining)])
      )
    } catch (e) {
      console.error('getReturnSummary failed (Exchange)', e)
      remById = {}
    }

    const rows: RetRow[] = lines.map((it:any) => {
      const item_id = Number(it.item_id)
      const mrp = Number(it.mrp ?? 0)
      const soldQty = Number(it.quantity ?? 0)
      const remaining = remById[item_id] ?? soldQty
      return {
        item_id,
        name: nameOf(it),
        brand: brandOf(it) || summaryById[item_id]?.brand || null,
        qty: 0,
        max: remaining,
        mrp,
        charged_unit_price: Number(summaryById[item_id]?.charged_unit_price ?? 0) || undefined,
        remaining_value: Number(summaryById[item_id]?.remaining_value ?? 0),
        loose_sale_enabled: Boolean(summaryById[item_id]?.loose_sale_enabled),
        is_loose_stock: Boolean(summaryById[item_id]?.is_loose_stock),
        conversion_qty: Number(summaryById[item_id]?.conversion_qty || 0) || null,
        child_unit_name: summaryById[item_id]?.child_unit_name || null,
      }
    })

    setRet(rows)
    setAdd([]) // clear added items when bill changes
    setExDiscount(0)
    setPaymentMode('cash')
    setPaymentCashSplit('')
    setPaymentOnlineSplit('')
    setPaymentCreditSplit('')
    setRefundMode('cash')
    setRefundCashSplit('')
    setRefundOnlineSplit('')
    setRefundCreditSplit('')
  }

  // ====== return pricing context ======
  const pricing = useMemo(() => {
    if (!bill) return { factor: 1, disc: 0, tax: 0, final: 0, computed: 0 }
    const items = (bill.items || []) as any[]
    const sub = items.reduce((s, it) => s + Number(it.mrp) * Number(it.quantity), 0)
    const discAmt = sub * Number(bill.discount_percent || 0) / 100
    const afterDisc = sub - discAmt
    const taxAmt = afterDisc * Number(bill.tax_percent || 0) / 100
    const computed = afterDisc + taxAmt
    const final = Number(bill.original_total_amount ?? bill.total_amount ?? computed)
    const factor = computed > 0 ? final / computed : 1
    return {
      factor,
      disc: Number(bill.discount_percent || 0),
      tax: Number(bill.tax_percent || 0),
      final,
      computed
    }
  }, [bill])

  const savedBillLineTotal = useMemo(
    () => (bill?.items || []).reduce((sum: number, item: any) => sum + Number(item.line_total || 0), 0),
    [bill]
  )

  const chargedLine = (itemId:number, mrp:number, qty:number, chargedUnitPrice?:number, remainingValue?:number, remainingQty?:number) => {
    if (remainingValue != null && Number(remainingQty || 0) > 0) {
      return qty === Number(remainingQty)
        ? round2(Number(remainingValue))
        : round2(Number(remainingValue) * Number(qty) / Number(remainingQty))
    }
    if (chargedUnitPrice != null && Number.isFinite(Number(chargedUnitPrice))) {
      return round2(Number(chargedUnitPrice) * Number(qty))
    }
    const saved = (bill?.items || []).find((item: any) => Number(item.item_id) === Number(itemId))
    const soldQty = Number(saved?.quantity || 0)
    const savedTotal = Number(saved?.line_total || 0)
    if (soldQty > 0 && savedTotal > 0) {
      const legacyFactor = savedBillLineTotal > 0 ? Math.min(1, Number(pricing.final || savedBillLineTotal) / savedBillLineTotal) : 1
      return round2((savedTotal / soldQty) * Number(qty) * legacyFactor)
    }
    return round2(Number(mrp) * Number(qty) * pricing.factor)
  }

  const automaticReturnLine = (r: RetRow) => {
    const sealedValue = chargedLine(r.item_id, r.mrp, r.qty, r.charged_unit_price, r.remaining_value, r.max)
    return r.opened_loose_quantity && Number(r.conversion_qty || 0) > 0
      ? round2(sealedValue * r.opened_loose_quantity / Number(r.conversion_qty))
      : sealedValue
  }

  const returnAmt = useMemo(() => {
    if (!bill) return 0
    return ret.reduce((s, r) => s + (r.custom_return_value == null
      ? automaticReturnLine(r)
      : Number(r.custom_return_value)), 0)
  }, [bill, ret])

  const newAmt = useMemo(
    () => add.reduce((s, r) => s + Number(r.qty || 0) * Number(r.selling_price === '' || r.selling_price == null ? r.mrp : r.selling_price), 0),
    [add]
  )

  const reservedReplacementStock = useMemo(() => Object.fromEntries(add.map((row) => [
    row.inventory_lot_id ? `lot:${row.inventory_lot_id}` : `item:${row.item_id}`,
    Number(row.qty || 0),
  ])), [add])

  function updateReplacementQty(index: number, rawValue: string) {
    if (rawValue === '') {
      setAdd(prev => prev.map((row, i) => i === index ? { ...row, qty: '' } : row))
      return
    }
    const requested = Math.max(1, Math.floor(Number(rawValue)))
    const row = add[index]
    const maximum = Math.max(0, Number(row?.available_stock ?? requested))
    if (requested > maximum) {
      toast.push(`Only ${maximum} unit${maximum === 1 ? '' : 's'} of ${row?.name || 'this product'} are available. Quantity was reduced to ${maximum}.`, 'warning')
    }
    setAdd(prev => prev.map((item, i) => i === index ? { ...item, qty: Math.min(requested, maximum) } : item))
  }

  // ---------- EXCHANGE MATH (FE + BE must match) ----------

  // Base difference (no extra exchange discount)
  const baseDiff = newAmt - returnAmt // +ve = customer pays

  // Discount applies ONLY on new items
  const discountedNew = newAmt * (1 - (Number(exDiscount) || 0) / 100)

  // Auto delta = theoretical_net on backend
  const autoDelta = discountedNew - returnAmt        // +ve => customer pays, -ve => refund
  const autoAmountAbs = round2(Math.abs(autoDelta))

  // What we *show/edit* in the final amount box
  const chosenAmountAbs = autoAmountAbs

  // Decide sign for final amount (customer pays vs refund)
  const sign = autoDelta !== 0
    ? (autoDelta > 0 ? 1 : -1)
    : (baseDiff >= 0 ? 1 : -1)

  // This is the final net_due we want (with sign)
  const chosenDelta = sign * chosenAmountAbs

  // NEW: rounding_adjustment = final - theoretical
  const roundingAdjustment = round2(chosenDelta - autoDelta)   // NEW

  // -------------------------------------------------------

  function buildExchangePayload() {
    if (!bill) throw new Error('No bill loaded')

    const payload: any = {
      source_bill_id: Number(bill.id),
      return_items: ret
        .filter((r) => r.qty > 0)
        .map((r) => ({
          item_id: r.item_id,
          quantity: r.qty,
          ...(r.custom_return_value == null || r.custom_return_value === '' ? {} : { custom_return_value: round2(Number(r.custom_return_value)) }),
          ...(r.opened_loose_quantity ? { opened_loose_quantity: r.opened_loose_quantity } : {}),
        })),
      new_items: add.map((a) => ({
        item_id: a.item_id,
        quantity: Number(a.qty || 0),
        custom_unit_price: round2(Number(a.selling_price === '' || a.selling_price == null ? a.mrp : a.selling_price)),
      })),
      discount_percent: Number(exDiscount) || 0,  // extra discount on NEW items

      // NEW: tell backend how much we rounded
      rounding_adjustment: roundingAdjustment,    // 🔴 IMPORTANT

      notes: '',
      exchange_date: exchangeDate,
      payment_mode: chosenDelta < 0 ? refundMode : paymentMode,
      payment_cash: 0,
      payment_online: 0,
      payment_credit: 0,
      refund_cash: 0,
      refund_online: 0,
      refund_credit: 0,
    }

    if (chosenDelta > 0) {
      // customer pays
      const payAbs = round2(chosenDelta)
      if (paymentMode === 'cash') {
        payload.payment_cash = payAbs
      } else if (paymentMode === 'online') {
        payload.payment_online = payAbs
      } else if (paymentMode === 'credit') {
        payload.payment_credit = payAbs
      } else {
        const c = round2(Number(paymentCashSplit || 0))
        const o = round2(Number(paymentOnlineSplit || 0))
        const cr = round2(Number(paymentCreditSplit || 0))
        if (c < 0 || o < 0 || cr < 0) throw new Error('Payment split amounts cannot be negative')
        if (round2(c + o + cr) !== payAbs) {
          throw new Error(`Payment split mismatch. Cash + Online + Credit must equal ₹${payAbs.toFixed(2)}.`)
        }
        payload.payment_cash = c
        payload.payment_online = o
        payload.payment_credit = cr
      }
    } else if (chosenDelta < 0) {
      // refund to customer
      const refundAbs = round2(-chosenDelta)
      if (refundMode === 'credit') {
        payload.refund_credit = refundAbs
      } else if (refundMode === 'cash') {
        payload.refund_cash = refundAbs
      } else if (refundMode === 'online') {
        payload.refund_online = refundAbs
      } else {
        const c = round2(Number(refundCashSplit || 0))
        const o = round2(Number(refundOnlineSplit || 0))
        const cr = round2(Number(refundCreditSplit || 0))
        if (c < 0 || o < 0 || cr < 0) throw new Error('Refund split amounts cannot be negative')
        if (round2(c + o + cr) !== refundAbs) {
          throw new Error(`Refund split mismatch. Cash + Online + Credit must equal ₹${refundAbs.toFixed(2)}.`)
        }
        payload.refund_cash = c
        payload.refund_online = o
        payload.refund_credit = cr
      }
    }
    return payload
  }

  const mEx = useMutation({
    mutationFn: async () => createExchange(buildExchangePayload()),
    onSuccess: () => {
      toast.push('Exchange completed', 'success')
      setBill(null); setRet([]); setAdd([]); setQuery('')
      setExDiscount(0)
      setPaymentMode('cash'); setPaymentCashSplit(''); setPaymentOnlineSplit('')
      setPaymentCreditSplit('')
      setRefundMode('cash'); setRefundCashSplit(''); setRefundOnlineSplit(''); setRefundCreditSplit('')
      queryClient.invalidateQueries({ queryKey: ['exchange-history'] })
      queryClient.invalidateQueries()
    },
    onError: (err: any) => {
      const d = err?.response?.data
      let msg = err?.message || 'Failed to create exchange'

      if (d?.detail) {
        if (Array.isArray(d.detail)) {
          msg = d.detail.map((e:any) =>
            [ ...(e.loc || []), e.msg ].filter(Boolean).join(' → ')
          ).join('\n')
        } else if (typeof d.detail === 'string') {
          msg = d.detail
        } else {
          msg = asString(d.detail)
        }
      } else if (d) {
        msg = asString(d)
      }

      console.error('Exchange error (full):', err)
      console.error('Exchange error response:', d)
      toast.push(msg, 'error')
    },
  })

  function submitExchange() {
    if (ret.every((r) => r.qty === 0) || add.length === 0) {
      toast.push('Keep at least one returned product and one replacement product', 'warning')
      return
    }
    if (add.some((row) => Number(row.qty || 0) <= 0)) {
      toast.push('Enter a valid replacement quantity', 'warning')
      return
    }
    if (editExchange) {
      if (!editMutation.isPending) editMutation.mutate()
    } else if (!mEx.isPending) mEx.mutate()
  }

  return (
    <Stack gap={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">{editExchange ? `Edit Exchange #${editExchange.id}` : 'Exchange'}</Typography>
        {editExchange ? <Button variant="outlined" onClick={() => { setEditExchange(null); setBill(null); setRet([]); setAdd([]); setQuery(''); setReleasedExchangeItems([]); setReleasedQtyByItemId({}); setSearchParams({}, { replace: true }) }}>Cancel Edit</Button> : null}
      </Stack>
      {editLoading ? <Typography color="text.secondary">Loading exchange into the editor…</Typography> : null}

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <TextField label="Bill Number" value={query} onChange={(e) => setQuery(e.target.value)} disabled={Boolean(editExchange)} fullWidth />
          <Button variant="contained" onClick={load} disabled={!query || Boolean(editExchange)}>Load Bill</Button>
          <Button variant="outlined" onClick={() => setBillPickerOpen(true)} disabled={Boolean(editExchange)}>Find Bill</Button>
          <TextField
            label="Exchange Date"
            type="date"
            value={exchangeDate}
            onChange={(e) => setExchangeDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            inputProps={{ max: today }}
            sx={{ minWidth: 180 }}
          />
        </Stack>
      </Paper>

      {bill && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Return from Bill #{bill.bill_number || bill.id}
          </Typography>

          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Avail. to Exchange</th>
                  <th>Return Qty</th>
                  <th>MRP</th>
                  <th>Return Value</th>
                  {editExchange ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {ret.map((r, i) => (
                  <tr key={`${r.item_id}-${i}`}>
                    <td>
                      <Stack gap={0.25}>
                        <Typography variant="body2">{r.name}</Typography>
                        {r.brand ? (
                          <Typography variant="caption" color="text.secondary">
                            {r.brand}
                          </Typography>
                        ) : null}
                      </Stack>
                    </td>
                    <td>{r.max}</td>
                    <td>
                      <Stack gap={0.75} alignItems="flex-start">
                        <TextField
                          type="number"
                          value={r.qty}
                          disabled={Boolean(r.opened_loose_quantity)}
                          onChange={(e) =>
                            setRet((prev) =>
                              prev.map((x, idx) =>
                                idx === i ? { ...x, qty: clamp(Number(e.target.value || 0), 0, r.max), custom_return_value: undefined } : x
                              )
                            )
                          }
                          inputProps={{ min: 0, max: r.max }} sx={{ width: 110 }}
                        />
                        {r.loose_sale_enabled && !r.is_loose_stock && Number(r.conversion_qty || 0) > 1 && r.max > 0 ? (
                          r.opened_loose_quantity ? (
                            <Button size="small" onClick={() => setRet(prev => prev.map((x, idx) => idx === i ? { ...x, opened_loose_quantity: undefined, custom_return_value: undefined } : x))}>
                              Return sealed box
                            </Button>
                          ) : (
                            <Button size="small" variant="outlined" onClick={() => setRet(prev => prev.map((x, idx) => idx === i ? { ...x, qty: 1, opened_loose_quantity: Math.max(1, Math.floor(Number(x.conversion_qty || 2) / 2)), custom_return_value: undefined } : x))}>
                              Open returned box
                            </Button>
                          )
                        ) : null}
                        {r.opened_loose_quantity ? (
                          <TextField
                            size="small" type="number"
                            label={`${r.child_unit_name || 'Loose units'} returned`}
                            value={r.opened_loose_quantity}
                            onChange={(e) => setRet(prev => prev.map((x, idx) => idx === i ? { ...x, opened_loose_quantity: clamp(Math.floor(Number(e.target.value || 1)), 1, Number(x.conversion_qty || 2) - 1), custom_return_value: undefined } : x))}
                            inputProps={{ min: 1, max: Number(r.conversion_qty || 2) - 1 }} sx={{ width: 160 }}
                          />
                        ) : null}
                      </Stack>
                    </td>
                    <td>{r.mrp}</td>
                    <td>
                      <Stack direction="row" alignItems="center" gap={0.5}>
                        {r.editing_return_value ? (
                          <TextField
                            autoFocus size="small" type="number" value={r.custom_return_value ?? ''}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => setRet(prev => prev.map((x, idx) => idx === i ? { ...x, custom_return_value: e.target.value === '' ? '' : Math.max(0, Number(e.target.value)) } : x))}
                            onBlur={() => setRet(prev => prev.map((x, idx) => idx === i ? { ...x, editing_return_value: false } : x))}
                            inputProps={{ min: 0, step: '0.01' }} sx={{ width: 120 }}
                          />
                        ) : (
                          <Typography variant="body2">
                            {(r.custom_return_value == null || r.custom_return_value === '' ? automaticReturnLine(r) : Number(r.custom_return_value)).toFixed(2)}
                          </Typography>
                        )}
                        <IconButton size="small" aria-label={`Edit return value for ${r.name}`} onClick={() => setRet(prev => prev.map((x, idx) => idx === i ? { ...x, editing_return_value: true, custom_return_value: x.custom_return_value ?? automaticReturnLine(x) } : x))}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </td>
                    {editExchange ? <td><IconButton color="error" aria-label={`Remove ${r.name} from return`} disabled={r.qty === 0} onClick={() => setRet(prev => prev.map((x, idx) => idx === i ? { ...x, qty: 0, custom_return_value: undefined, opened_loose_quantity: undefined } : x))}><DeleteIcon /></IconButton></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>

          <Box mt={3}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="subtitle1">Add New Items</Typography>
              <Button onClick={() => setPicker(true)} variant="outlined">Add Item</Button>
            </Stack>

            <Box sx={{ overflowX: 'auto', mt: 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>MRP</th>
                    <th>Selling Price</th>
                    <th>Qty</th>
                    <th>Line</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {add.map((r, i) => (
                    <tr key={`${r.item_id}-${i}`}>
                      <td>
                        <Stack gap={0.25}>
                          <Typography variant="body2">{r.name}</Typography>
                          {r.brand ? (
                            <Typography variant="caption" color="text.secondary">
                              {r.brand}
                            </Typography>
                          ) : null}
                        </Stack>
                      </td>
                      <td>{r.mrp}</td>
                      <td>
                        <TextField
                          type="number" size="small"
                          value={r.selling_price ?? r.mrp}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setAdd(prev => prev.map((x, idx) => idx === i ? { ...x, selling_price: e.target.value === '' ? '' : Math.max(0, Number(e.target.value)) } : x))}
                          inputProps={{ min: 0, step: '0.01' }} sx={{ width: 125 }}
                        />
                      </td>
                      <td>
                        <TextField
                          type="number"
                          value={r.qty}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => updateReplacementQty(i, e.target.value)}
                          onBlur={() => setAdd(prev => prev.map((x, idx) => idx === i && x.qty === '' ? { ...x, qty: 1 } : x))}
                          inputProps={{ min: 1, max: r.available_stock }}
                          sx={{ width: 110 }}
                        />
                      </td>
                      <td>{(Number(r.qty || 0) * Number(r.selling_price === '' || r.selling_price == null ? r.mrp : r.selling_price)).toFixed(2)}</td>
                      <td>
                        <IconButton
                          aria-label="Remove item"
                          onClick={() =>
                            setAdd(prev => prev.filter((_, idx) => idx !== i))
                          }
                          sx={{ color: 'red' }}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                  {add.length === 0 && (
                    <tr><td colSpan={6}><Box p={2}>No new items.</Box></td></tr>
                  )}
                </tbody>
              </table>
            </Box>
          </Box>

          {/* Summary + discount + final amount */}
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            justifyContent="space-between"
            mt={4}
            gap={4}
            sx={{ pt: 2, borderTop: '1px solid', borderColor: 'divider' }}
          >
            <Typography>
              Return Value: ₹{returnAmt.toFixed(2)} | New Items: ₹{newAmt.toFixed(2)}
            </Typography>

            <Stack alignItems={{ xs: 'stretch', md: 'flex-end' }} gap={2} sx={{ minWidth: { md: 680 } }}>
              <Typography variant="body2" color="text.secondary">
                Base {baseDiff >= 0 ? 'Customer Pays' : 'Refund'} (no extra discount): ₹{Math.abs(baseDiff).toFixed(2)}
              </Typography>

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                alignItems="center"
                justifyContent="flex-end"
              >
                <TextField
                  size="small"
                  label="Exchange Discount % (on new items)"
                  type="number"
                  value={exDiscount}
                  onChange={(e) => setExDiscount(Number(e.target.value || 0))}
                  sx={{ width: 210 }}
                />
              </Stack>

              {chosenDelta > 0 && (
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={2}
                  alignItems="center"
                  justifyContent="flex-end"
                >
                  <TextField
                    select
                    size="small"
                    label="Payment Mode"
                    value={paymentMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'cash' | 'online' | 'split' | 'credit'
                      setPaymentMode(mode)
                      if (mode !== 'split') {
                        setPaymentCashSplit('')
                        setPaymentOnlineSplit('')
                        setPaymentCreditSplit('')
                      }
                    }}
                    sx={{ width: 210 }}
                  >
                    <MenuItem value="cash">Cash</MenuItem>
                    <MenuItem value="online">Online</MenuItem>
                    <MenuItem value="split">Split</MenuItem>
                    <MenuItem value="credit">Credit</MenuItem>
                  </TextField>

                  {paymentMode === 'split' && (
                    <>
                      <TextField
                        size="small"
                        label="Payment Cash"
                        type="number"
                        value={paymentCashSplit}
                        onChange={(e) => setPaymentCashSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small"
                        label="Payment Online"
                        type="number"
                        value={paymentOnlineSplit}
                        onChange={(e) => setPaymentOnlineSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small" label="Payment Credit" type="number"
                        value={paymentCreditSplit}
                        onChange={(e) => setPaymentCreditSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }} inputProps={{ min: 0, step: '0.01' }}
                      />
                    </>
                  )}
                </Stack>
              )}

              {chosenDelta < 0 && (
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={2}
                  alignItems="center"
                  justifyContent="flex-end"
                >
                  <TextField
                    select
                    size="small"
                    label="Refund Mode"
                    value={refundMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'cash' | 'online' | 'split' | 'credit'
                      setRefundMode(mode)
                      if (mode !== 'split') {
                        setRefundCashSplit('')
                        setRefundOnlineSplit('')
                        setRefundCreditSplit('')
                      }
                    }}
                    sx={{ width: 210 }}
                  >
                    <MenuItem value="cash">Cash</MenuItem>
                    <MenuItem value="online">Online</MenuItem>
                    <MenuItem value="split">Split</MenuItem>
                    <MenuItem value="credit">Credit (customer balance)</MenuItem>
                  </TextField>

                  {refundMode === 'split' && (
                    <>
                      <TextField
                        size="small"
                        label="Refund Cash"
                        type="number"
                        value={refundCashSplit}
                        onChange={(e) => setRefundCashSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small"
                        label="Refund Online"
                        type="number"
                        value={refundOnlineSplit}
                        onChange={(e) => setRefundOnlineSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small" label="Refund Credit" type="number"
                        value={refundCreditSplit}
                        onChange={(e) => setRefundCreditSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }} inputProps={{ min: 0, step: '0.01' }}
                      />
                    </>
                  )}
                </Stack>
              )}

              <Typography variant="h6">
                {chosenDelta >= 0
                  ? `Customer Pays: ₹${chosenAmountAbs.toFixed(2)}`
                  : `Refund to Customer: ₹${chosenAmountAbs.toFixed(2)}`
                }
              </Typography>
            </Stack>
          </Stack>

          <Box textAlign="right" mt={4} pt={1}>
            <Button
              variant="contained"
              disabled={mEx.isPending || editMutation.isPending || editLoading}
              onClick={submitExchange}
            >
              {editMutation.isPending ? 'Saving…' : mEx.isPending ? 'Submitting…' : editExchange ? 'Save Exchange' : 'Submit Exchange'}
            </Button>
          </Box>
        </Paper>
      )}

      {editExchange ? (
        <Paper sx={{ p: 3 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1} mb={2}>
            <Box>
              <Typography variant="h6">History for Exchange #{editExchange.id}</Typography>
              <Typography variant="body2" color="text.secondary">Only changes made to this exchange are shown here.</Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">{openExchangeHistory.data?.length || 0} event{openExchangeHistory.data?.length === 1 ? '' : 's'}</Typography>
          </Stack>
          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>Date & Time</th><th>Action</th><th>Details</th><th>User</th></tr></thead>
              <tbody>
                {(openExchangeHistory.data || []).map((event) => {
                  const details = exchangeAuditDetails(event.details_json)
                  return <tr key={event.id}>
                    <td>{String(event.event_ts || '').replace('T', ' ').slice(0, 19)}</td>
                    <td>{String(event.action || '').replaceAll('_', ' ')}</td>
                    <td style={{ minWidth: 360, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                      <Stack gap={0.5}>
                        <Typography variant="body2">{event.note || '—'}</Typography>
                        {details.map((detail, index) => <Typography key={`${event.id}-detail-${index}`} variant="caption" color="text.secondary">• {detail}</Typography>)}
                      </Stack>
                    </td>
                    <td>{event.actor || 'System'}</td>
                  </tr>
                })}
                {openExchangeHistory.isLoading ? <tr><td colSpan={4}><Box p={2}>Loading this exchange’s history…</Box></td></tr> : null}
                {!openExchangeHistory.isLoading && (openExchangeHistory.data || []).length === 0 ? <tr><td colSpan={4}><Box p={2}>No recorded changes for this exchange yet.</Box></td></tr> : null}
              </tbody>
            </table>
          </Box>
        </Paper>
      ) : (
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
          <Typography variant="h6">Exchange History</Typography>
          <Typography variant="body2" color="text.secondary">
            {historyFiltersActive
              ? `${filteredHistory.length} of ${history.data?.length || 0}`
              : history.data?.length || 0}{' '}
            record{filteredHistory.length === 1 ? '' : 's'}
          </Typography>
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} mb={2}>
          <TextField
            size="small"
            label="Search IDs"
            placeholder="Exchange, source bill, return or new bill"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            sx={{ minWidth: 280, flexGrow: 1 }}
          />
          <TextField
            size="small"
            label="From"
            type="date"
            value={historyFrom}
            onChange={(e) => setHistoryFrom(e.target.value)}
            InputLabelProps={{ shrink: true }}
            inputProps={{ max: historyTo || undefined }}
            sx={{ minWidth: 155 }}
          />
          <TextField
            size="small"
            label="To"
            type="date"
            value={historyTo}
            onChange={(e) => setHistoryTo(e.target.value)}
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: historyFrom || undefined }}
            sx={{ minWidth: 155 }}
          />
          <TextField
            select
            size="small"
            label="Settlement"
            value={historySettlement}
            onChange={(e) => setHistorySettlement(e.target.value as typeof historySettlement)}
            sx={{ minWidth: 155 }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="cash">Cash</MenuItem>
            <MenuItem value="online">Online</MenuItem>
            <MenuItem value="split">Split</MenuItem>
            <MenuItem value="credit">Credit</MenuItem>
          </TextField>
          <Button
            variant="outlined"
            disabled={!historyFiltersActive}
            onClick={() => {
              setHistorySearch('')
              setHistoryFrom('')
              setHistoryTo('')
              setHistorySettlement('all')
            }}
          >
            Clear
          </Button>
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Exchange</th><th>Source Bill</th><th>Return</th><th>New Bill</th>
                <th>Settlement</th><th>Customer Pays / (Credit)</th><th>Refund / (Credit)</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((row) => {
                const credit = row.payment_mode === 'credit'
                const payable = Number(row.net_due || 0) > 0 ? Number(row.net_due) : 0
                const refundable = Number(row.net_due || 0) < 0 ? Math.abs(Number(row.net_due)) : 0
                return (
                  <tr key={row.id}>
                    <td>{String(row.created_at || '').slice(0, 10)}</td>
                    <td>#{row.id}</td>
                    <td>{row.source_bill_id ? `#${row.source_bill_id}` : '—'}</td>
                    <td>#{row.return_id}</td>
                    <td>#{row.new_bill_id}</td>
                    <td>{credit ? 'Credit' : row.payment_mode}</td>
                    <td>{payable ? `₹${payable.toFixed(2)}${credit ? ' credit' : ''}` : '—'}</td>
                    <td>{refundable ? `₹${refundable.toFixed(2)}${credit ? ' credit' : ''}` : '—'}</td>
                    <td>
                      <IconButton aria-label={`Edit exchange ${row.id}`} onClick={() => openExchangeEditor(row)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton color="error" aria-label={`Undo exchange ${row.id}`} onClick={() => setUndoTarget(row)}>
                        <UndoIcon fontSize="small" />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
              {!history.isLoading && filteredHistory.length === 0 && (
                <tr><td colSpan={9}><Box p={2}>{historyFiltersActive ? 'No exchanges match these filters.' : 'No exchange records yet.'}</Box></td></tr>
              )}
              {history.isLoading && <tr><td colSpan={9}><Box p={2}>Loading history…</Box></td></tr>}
            </tbody>
          </table>
        </Box>
      </Paper>
      )}

      <Dialog open={Boolean(undoTarget)} onClose={() => !undoMutation.isPending && setUndoTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Undo Exchange #{undoTarget?.id}?</DialogTitle>
        <DialogContent>
          <Typography>
            This reverses both the return and replacement bill, restores their stock movements, and removes the exchange settlement. It will be blocked if returned stock or customer credit has already been used.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUndoTarget(null)} disabled={undoMutation.isPending}>Cancel</Button>
          <Button color="error" variant="contained" disabled={undoMutation.isPending} onClick={() => undoTarget && undoMutation.mutate(undoTarget.id)}>
            {undoMutation.isPending ? 'Undoing…' : 'Undo Exchange'}
          </Button>
        </DialogActions>
      </Dialog>

      <ItemPicker
        open={picker}
        onClose={() => setPicker(false)}
        reservedByItemId={reservedReplacementStock}
        additionalItems={editExchange ? releasedExchangeItems : []}
        stockAdjustmentsByItemId={editExchange ? releasedQtyByItemId : {}}
        onPick={(it: any) => {
          setAdd((prev) => {
            const idx = prev.findIndex((p) => p.item_id === it.id)
            const mrp = Number(it.mrp) || 0
            if (idx >= 0) {
              const c = [...prev]
              c[idx] = { ...c[idx], qty: Number(c[idx].qty || 0) + 1, mrp, selling_price: c[idx].selling_price ?? mrp, brand: it.brand ?? c[idx].brand ?? null }
              return c
            }
            return [...prev, { item_id: it.id, name: it.name, brand: it.brand || null, mrp, selling_price: mrp, qty: 1, available_stock: Number(it.stock || 0), inventory_lot_id: it.inventory_lot_id || null }]
          })
        }}
      />

      <BillPickerDialog
        open={billPickerOpen}
        onClose={() => setBillPickerOpen(false)}
        onPick={(b: any) => {
          setBillPickerOpen(false)
          setQuery(String(b.id))
          setTimeout(() => load(), 0)
        }}
      />
    </Stack>
  )
}
