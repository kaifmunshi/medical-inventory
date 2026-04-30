import { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Grid,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import PaymentsIcon from '@mui/icons-material/Payments'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { fetchParties } from '../../services/parties'
import { listIncomingStockEntries, type IncomingStockEntry } from '../../services/inventory'
import { createBrand, createCategory, fetchBrands, fetchCategories, fetchProducts } from '../../services/products'
import { addSupplierPayment, fetchPurchases, replacePurchaseItems, updatePurchase } from '../../services/purchases'
import type { Category, Party, Product, Purchase, PurchaseItemPayload } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'

type DraftItem = PurchaseItemPayload & { key: string; existing_stock_movement_id?: number }

const EXISTING_INVENTORY_FROM_DATE = '2026-04-01'

function makeEmptyItem(): DraftItem {
  return {
    key: Math.random().toString(36).slice(2),
    product_name: '',
    alias: '',
    brand: '',
    category_id: undefined,
    expiry_date: '',
    rack_number: 0,
    sealed_qty: 1,
    free_qty: 0,
    cost_price: 0,
    mrp: 0,
    gst_percent: 0,
    discount_amount: 0,
    rounding_adjustment: 0,
    loose_sale_enabled: false,
    parent_unit_name: '',
    child_unit_name: '',
    conversion_qty: undefined,
  }
}

function round2(n: number) {
  return Math.round(Number(n || 0) * 100) / 100
}

function money(n: number | string | null | undefined) {
  return Number(n || 0).toFixed(2)
}

function dateOnly(value?: string | null) {
  const raw = String(value || '')
  return raw.length >= 10 ? raw.slice(0, 10) : '-'
}

function dateValue(value?: string | null) {
  const raw = String(value || '')
  const time = Date.parse(raw.length === 10 ? `${raw}T00:00:00` : raw)
  return Number.isFinite(time) ? time : 0
}

function openingForSupplier(supplier?: Party | null) {
  if (!supplier) return 0
  const amount = Number(supplier.opening_balance || 0)
  return supplier.opening_balance_type === 'DR' ? -amount : amount
}

function outstandingOf(purchase: Purchase) {
  return round2(
    Math.max(
      0,
      Number(purchase.total_amount || 0) -
        Number(purchase.paid_amount || 0) -
        Number(purchase.writeoff_amount || 0),
    ),
  )
}

function paymentModeLabel(mode?: string | null) {
  const raw = String(mode || '').toLowerCase()
  if (raw === 'online') return 'Online'
  if (raw === 'split') return 'Split'
  if (raw === 'writeoff') return 'Write-off'
  return 'Cash'
}

function lineGrossTotal(item: Pick<DraftItem, 'sealed_qty' | 'cost_price'>) {
  return Number(item.sealed_qty || 0) * Number(item.cost_price || 0)
}

function lineBaseTotal(item: Pick<DraftItem, 'sealed_qty' | 'cost_price' | 'discount_amount' | 'rounding_adjustment'>) {
  return lineGrossTotal(item) - Number(item.discount_amount || 0) + Number(item.rounding_adjustment || 0)
}

function lineEffectiveCost(item: Pick<DraftItem, 'sealed_qty' | 'free_qty' | 'cost_price' | 'discount_amount' | 'rounding_adjustment'>) {
  const totalQty = Number(item.sealed_qty || 0) + Number(item.free_qty || 0)
  if (totalQty <= 0) return 0
  return lineBaseTotal(item) / totalQty
}

function fmtDate(value?: string | null) {
  const raw = String(value || '')
  if (!raw) return '-'
  try {
    return new Date(raw).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return raw.slice(0, 10)
  }
}

function incomingEntryLabel(entry: IncomingStockEntry) {
  const parts = [
    `#${entry.item_id}`,
    `Incoming ${fmtDate(entry.incoming_at)}`,
    `+${Number(entry.delta || 0)}`,
    entry.name,
    entry.brand || '',
    entry.expiry_date ? `Exp ${entry.expiry_date}` : '',
    `MRP ${money(entry.mrp)}`,
    `Current ${Number(entry.stock || 0)}`,
    entry.reason || '',
  ].filter(Boolean)
  return parts.join(' | ')
}

export default function SupplierLedgerPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const today = new Date().toISOString().slice(0, 10)
  const [partyId, setPartyId] = useState<number | null>(
    params.get('supplier_id') ? Number(params.get('supplier_id')) : null,
  )
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentType, setPaymentType] = useState<'payment' | 'writeoff'>('payment')
  const [paymentMode, setPaymentMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [paymentCash, setPaymentCash] = useState('0')
  const [paymentOnline, setPaymentOnline] = useState('0')
  const [paymentDate, setPaymentDate] = useState(today)
  const [paymentNote, setPaymentNote] = useState('')
  const [allocationDrafts, setAllocationDrafts] = useState<Record<number, string>>({})
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<number | null>(null)
  const [editHeaderOpen, setEditHeaderOpen] = useState(false)
  const [editItemsOpen, setEditItemsOpen] = useState(false)
  const [editPartyId, setEditPartyId] = useState<number | null>(null)
  const [editInvoiceNumber, setEditInvoiceNumber] = useState('')
  const [editInvoiceDate, setEditInvoiceDate] = useState(today)
  const [editNotes, setEditNotes] = useState('')
  const [editDiscountAmount, setEditDiscountAmount] = useState('0')
  const [editRoundingAdjustment, setEditRoundingAdjustment] = useState('0')
  const [editItems, setEditItems] = useState<DraftItem[]>([makeEmptyItem()])
  const [productSearch, setProductSearch] = useState('')
  const [inventorySearch, setInventorySearch] = useState('')
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [categoryTargetKey, setCategoryTargetKey] = useState<string | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [brandDialogOpen, setBrandDialogOpen] = useState(false)
  const [brandTargetKey, setBrandTargetKey] = useState<string | null>(null)
  const [newBrandName, setNewBrandName] = useState('')

  const suppliersQ = useQuery<Party[], Error>({
    queryKey: ['suppliers-ledger-select'],
    queryFn: () => fetchParties({ party_group: 'SUNDRY_CREDITOR', is_active: true }),
  })

  const purchasesQ = useQuery<Purchase[], Error>({
    queryKey: ['supplier-ledger-purchases', partyId],
    queryFn: () => fetchPurchases({ party_id: Number(partyId), limit: 500 }),
    enabled: Boolean(partyId),
  })

  const categoriesQ = useQuery<Category[], Error>({
    queryKey: ['purchase-categories'],
    queryFn: () => fetchCategories(),
  })

  const brandsQ = useQuery({
    queryKey: ['purchase-brands'],
    queryFn: () => fetchBrands({ active_only: true }),
  })

  const productsQ = useQuery<Product[], Error>({
    queryKey: ['purchase-products', productSearch],
    queryFn: () => fetchProducts({ q: productSearch.trim() || undefined }),
  })

  const inventoryBatchesQ = useQuery<IncomingStockEntry[], Error>({
    queryKey: ['purchase-existing-inventory', inventorySearch, EXISTING_INVENTORY_FROM_DATE],
    queryFn: () => listIncomingStockEntries(inventorySearch.trim(), {
      include_archived: true,
      incoming_from: EXISTING_INVENTORY_FROM_DATE,
    }),
  })

  const suppliers = suppliersQ.data || []
  const categories = categoriesQ.data || []
  const brandNames = (brandsQ.data || []).map((brand) => brand.name)
  const products = productsQ.data || []
  const inventoryBatches = inventoryBatchesQ.data || []
  const selectedSupplier = suppliers.find((supplier) => Number(supplier.id) === Number(partyId)) || null
  const purchases = purchasesQ.data || []
  const openingBalance = openingForSupplier(selectedSupplier)
  const openPurchases = purchases.filter((purchase) => outstandingOf(purchase) > 0.0001)
  const selectedPurchase = purchases.find((purchase) => Number(purchase.id) === Number(selectedPurchaseId)) || null

  const ledgerRows = useMemo(() => {
    const events = purchases.flatMap((purchase) => {
      const purchaseEvent = {
        id: `purchase-${purchase.id}`,
        sortTs: `${purchase.invoice_date || dateOnly(purchase.created_at)}T00:00:00`,
        sortOrder: 0,
        type: 'PURCHASE' as const,
        purchaseId: Number(purchase.id),
        paymentId: null as number | null,
        date: purchase.invoice_date || dateOnly(purchase.created_at),
        particulars: `Purchase ${purchase.invoice_number || `#${purchase.id}`}`,
        purchaseAmount: Number(purchase.total_amount || 0),
        paidAmount: 0,
        writeoffAmount: 0,
        mode: '',
        note: purchase.notes || '',
      }
      const paymentEvents = (purchase.payments || [])
        .filter((payment) => !payment.is_deleted)
        .map((payment) => ({
          id: `payment-${payment.id}`,
          sortTs: payment.paid_at || purchase.updated_at,
          sortOrder: 1,
          type: payment.is_writeoff ? 'WRITEOFF' as const : 'PAYMENT' as const,
          purchaseId: Number(purchase.id),
          paymentId: Number(payment.id),
          date: dateOnly(payment.paid_at),
          particulars: `${payment.is_writeoff ? 'Write-off' : 'Payment'} for ${purchase.invoice_number || `#${purchase.id}`}`,
          purchaseAmount: 0,
          paidAmount: payment.is_writeoff ? 0 : Number(payment.amount || 0),
          writeoffAmount: payment.is_writeoff ? Number(payment.amount || 0) : 0,
          mode: paymentModeLabel(payment.mode),
          note: payment.note || '',
        }))
      return [purchaseEvent, ...paymentEvents]
    })

    events.sort((a, b) => {
      const byDate = dateValue(a.sortTs) - dateValue(b.sortTs)
      if (byDate !== 0) return byDate
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return String(a.id).localeCompare(String(b.id))
    })

    let balance = openingBalance
    return events.map((event) => {
      const before = balance
      const delta =
        Number(event.purchaseAmount || 0) -
        Number(event.paidAmount || 0) -
        Number(event.writeoffAmount || 0)
      balance = round2(balance + delta)
      return {
        ...event,
        balanceBefore: before,
        balanceAfter: balance,
      }
    }).reverse()
  }, [openingBalance, purchases])

  const totals = useMemo(() => {
    const totalPurchases = purchases.reduce((sum, purchase) => sum + Number(purchase.total_amount || 0), 0)
    const totalPaid = purchases.reduce((sum, purchase) => sum + Number(purchase.paid_amount || 0), 0)
    const totalWriteoff = purchases.reduce((sum, purchase) => sum + Number(purchase.writeoff_amount || 0), 0)
    const closingBalance = openingBalance + totalPurchases - totalPaid - totalWriteoff
    return { totalPurchases, totalPaid, totalWriteoff, closingBalance }
  }, [openingBalance, purchases])

  const editItemsSubtotal = useMemo(
    () => editItems.reduce((sum, item) => sum + lineBaseTotal(item), 0),
    [editItems],
  )

  const allocationTotal = useMemo(
    () => round2(Object.values(allocationDrafts).reduce((sum, value) => sum + Number(value || 0), 0)),
    [allocationDrafts],
  )
  const allocationIssueByPurchaseId = useMemo(() => {
    const issues: Record<number, string> = {}
    for (const [purchaseId, value] of Object.entries(allocationDrafts)) {
      const id = Number(purchaseId)
      const amount = Number(value || 0)
      const purchase = purchases.find((row) => Number(row.id) === id)
      if (Number.isNaN(amount)) {
        issues[id] = 'Invalid amount'
      } else if (amount < 0) {
        issues[id] = 'Cannot be negative'
      } else if (purchase && amount > outstandingOf(purchase) + 0.01) {
        issues[id] = `Max ${money(outstandingOf(purchase))}`
      }
    }
    return issues
  }, [allocationDrafts, purchases])
  const hasAllocationIssues = Object.keys(allocationIssueByPurchaseId).length > 0
  const supplierPaymentCash =
    paymentType === 'writeoff' || paymentMode === 'online'
      ? 0
      : paymentMode === 'cash'
        ? allocationTotal
        : Number(paymentCash || 0)
  const supplierPaymentOnline =
    paymentType === 'writeoff' || paymentMode === 'cash'
      ? 0
      : paymentMode === 'online'
        ? allocationTotal
        : Number(paymentOnline || 0)
  const splitPaymentInvalid =
    paymentType === 'payment' &&
    paymentMode === 'split' &&
    (Number.isNaN(supplierPaymentCash) ||
      Number.isNaN(supplierPaymentOnline) ||
      supplierPaymentCash < 0 ||
      supplierPaymentOnline < 0)
  const supplierPaymentTotal =
    paymentType === 'writeoff' || paymentMode !== 'split'
      ? allocationTotal
      : round2(supplierPaymentCash + supplierPaymentOnline)
  const allocationDifference = round2(supplierPaymentTotal - allocationTotal)
  const canSavePayment =
    Boolean(partyId) &&
    allocationTotal > 0 &&
    !hasAllocationIssues &&
    !splitPaymentInvalid &&
    (paymentType === 'writeoff' || Math.abs(allocationDifference) <= 0.01)

  useEffect(() => {
    if (!paymentOpen || paymentType !== 'payment') return
    const total = money(allocationTotal)
    if (paymentMode === 'cash') {
      setPaymentCash((prev) => (prev === total ? prev : total))
      setPaymentOnline((prev) => (prev === '0' ? prev : '0'))
    } else if (paymentMode === 'online') {
      setPaymentCash((prev) => (prev === '0' ? prev : '0'))
      setPaymentOnline((prev) => (prev === total ? prev : total))
    } else if (paymentMode === 'split') {
      const cash = Number(paymentCash || 0)
      if (Number.isNaN(cash) || cash < 0) {
        setPaymentOnline((prev) => (prev === '0' ? prev : '0'))
      } else if (cash > allocationTotal) {
        setPaymentCash((prev) => (prev === total ? prev : total))
        setPaymentOnline((prev) => (prev === '0' ? prev : '0'))
      } else {
        const online = money(allocationTotal - cash)
        setPaymentOnline((prev) => (prev === online ? prev : online))
      }
    }
  }, [allocationTotal, paymentMode, paymentOpen, paymentType])

  const addPaymentM = useMutation({
    mutationFn: () =>
      addSupplierPayment(Number(partyId), {
        mode: paymentMode,
        cash_amount: supplierPaymentCash,
        online_amount: supplierPaymentOnline,
        payment_date: paymentDate,
        note: paymentNote.trim() || undefined,
        is_writeoff: paymentType === 'writeoff',
        allocations: Object.entries(allocationDrafts)
          .map(([purchaseId, amount]) => ({ purchase_id: Number(purchaseId), amount: Number(amount || 0) }))
          .filter((allocation) => allocation.amount > 0),
      }),
    onSuccess: () => {
      toast.push(paymentType === 'writeoff' ? 'Write-off added' : 'Supplier payment added', 'success')
      setPaymentOpen(false)
      setPaymentType('payment')
      setPaymentMode('cash')
      setPaymentCash('0')
      setPaymentOnline('0')
      setPaymentDate(today)
      setPaymentNote('')
      setAllocationDrafts({})
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-purchases'] })
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail'] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-summary'] })
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to add payment'), 'error'),
  })

  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) => updatePurchase(id, payload),
    onSuccess: (purchase) => {
      toast.push('Purchase updated', 'success')
      setEditHeaderOpen(false)
      setPartyId(Number(purchase.party_id))
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-purchases'] })
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update purchase'), 'error'),
  })

  const replaceItemsM = useMutation({
    mutationFn: ({ id, items }: { id: number; items: PurchaseItemPayload[] }) => replacePurchaseItems(id, items),
    onSuccess: (purchase) => {
      toast.push('Purchase items updated', 'success')
      setEditItemsOpen(false)
      setPartyId(Number(purchase.party_id))
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-purchases'] })
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory'] })
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to update purchase items'), 'error'),
  })

  const createCategoryM = useMutation({
    mutationFn: createCategory,
    onSuccess: (category) => {
      toast.push('Category added', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchase-categories'] })
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
      if (categoryTargetKey) {
        patchEditItem(categoryTargetKey, { category_id: Number(category.id) })
      }
      setCategoryDialogOpen(false)
      setCategoryTargetKey(null)
      setNewCategoryName('')
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to add category'), 'error'),
  })

  const createBrandM = useMutation({
    mutationFn: createBrand,
    onSuccess: (brand) => {
      toast.push('Brand added', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchase-brands'] })
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
      if (brandTargetKey) {
        patchEditItem(brandTargetKey, { brand: brand.name, product_id: undefined, existing_inventory_item_id: undefined })
      }
      setBrandDialogOpen(false)
      setBrandTargetKey(null)
      setNewBrandName('')
    },
    onError: (err: any) => toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to add brand'), 'error'),
  })

  function openPaymentDialog(purchase?: Purchase | null) {
    const target = purchase || null
    setPaymentType('payment')
    setPaymentMode('cash')
    setPaymentCash(target ? money(outstandingOf(target)) : '0')
    setPaymentOnline('0')
    setPaymentDate(today)
    setPaymentNote('')
    setAllocationDrafts(
      Object.fromEntries(
        openPurchases.map((row) => [
          Number(row.id),
          target && Number(target.id) === Number(row.id) ? money(outstandingOf(row)) : '0',
        ]),
      ),
    )
    setPaymentOpen(true)
  }

  function setDraft(purchaseId: number, value: string) {
    setAllocationDrafts((prev) => ({ ...prev, [purchaseId]: value }))
  }

  function setModeAndAmounts(next: 'cash' | 'online' | 'split') {
    setPaymentMode(next)
    const total = money(allocationTotal)
    if (next === 'cash') {
      setPaymentCash(total)
      setPaymentOnline('0')
    }
    if (next === 'online') {
      setPaymentCash('0')
      setPaymentOnline(total)
    }
    if (next === 'split') {
      setPaymentCash(total)
      setPaymentOnline('0')
    }
  }

  function setSplitCashAmount(value: string) {
    const cash = Number(value || 0)
    if (Number.isNaN(cash) || cash < 0) {
      setPaymentCash(value)
      setPaymentOnline('0')
      return
    }
    const cappedCash = Math.min(cash, allocationTotal)
    setPaymentCash(cash > allocationTotal ? money(allocationTotal) : value)
    setPaymentOnline(money(allocationTotal - cappedCash))
  }

  function setSplitOnlineAmount(value: string) {
    const online = Number(value || 0)
    if (Number.isNaN(online) || online < 0) {
      setPaymentOnline(value)
      setPaymentCash('0')
      return
    }
    const cappedOnline = Math.min(online, allocationTotal)
    setPaymentOnline(online > allocationTotal ? money(allocationTotal) : value)
    setPaymentCash(money(allocationTotal - cappedOnline))
  }

  function applyFullOutstanding(purchase: Purchase) {
    const amount = money(outstandingOf(purchase))
    setAllocationDrafts((prev) => ({ ...prev, [Number(purchase.id)]: amount }))
    if (paymentType !== 'writeoff') {
      if (paymentMode === 'online') setPaymentOnline(amount)
      else setPaymentCash(amount)
    }
  }

  function supplierNameFor(id: number) {
    return suppliers.find((supplier) => Number(supplier.id) === Number(id))?.name || `Supplier #${id}`
  }

  function openEditHeader() {
    if (!selectedPurchase) return
    setEditPartyId(Number(selectedPurchase.party_id))
    setEditInvoiceNumber(selectedPurchase.invoice_number || '')
    setEditInvoiceDate(selectedPurchase.invoice_date || today)
    setEditNotes(selectedPurchase.notes || '')
    setEditDiscountAmount(String(selectedPurchase.discount_amount || 0))
    setEditRoundingAdjustment(String(selectedPurchase.rounding_adjustment || 0))
    setEditHeaderOpen(true)
  }

  function openEditItems() {
    if (!selectedPurchase) return
    setEditItems((selectedPurchase.items || []).map((item) => ({
      key: Math.random().toString(36).slice(2),
      existing_inventory_item_id: item.stock_source === 'ATTACHED' && item.inventory_item_id ? item.inventory_item_id : undefined,
      product_id: item.product_id,
      product_name: item.product_name,
      alias: '',
      brand: item.brand || '',
      category_id: undefined,
      expiry_date: item.expiry_date || '',
      rack_number: item.rack_number,
      sealed_qty: item.sealed_qty,
      free_qty: item.free_qty,
      cost_price: item.cost_price,
      mrp: item.mrp,
      gst_percent: 0,
      discount_amount: item.discount_amount,
      rounding_adjustment: item.rounding_adjustment || 0,
      loose_sale_enabled: false,
      parent_unit_name: '',
      child_unit_name: '',
      conversion_qty: undefined,
    })))
    setEditItemsOpen(true)
  }

  function patchEditItem(key: string, patch: Partial<DraftItem>) {
    setEditItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  function applyProduct(itemKey: string, product: Product | null) {
    if (!product) return
    patchEditItem(itemKey, {
      existing_inventory_item_id: undefined,
      product_id: product.id,
      product_name: product.name,
      alias: product.alias || '',
      brand: product.brand || '',
      category_id: product.category_id ?? undefined,
      rack_number: product.default_rack_number || 0,
      loose_sale_enabled: product.loose_sale_enabled,
      parent_unit_name: product.parent_unit_name || '',
      child_unit_name: product.child_unit_name || '',
      conversion_qty: product.default_conversion_qty ?? undefined,
    })
  }

  function applyExistingInventory(itemKey: string, incomingEntry: IncomingStockEntry | null) {
    if (!incomingEntry) return
    patchEditItem(itemKey, {
      existing_stock_movement_id: incomingEntry.movement_id,
      existing_inventory_item_id: incomingEntry.item_id,
      product_id: incomingEntry.product_id ?? undefined,
      product_name: incomingEntry.name,
      brand: incomingEntry.brand || '',
      category_id: incomingEntry.category_id ?? undefined,
      expiry_date: incomingEntry.expiry_date || '',
      rack_number: incomingEntry.rack_number || 0,
      sealed_qty: Math.max(1, Number(incomingEntry.delta || 0)),
      cost_price: Number(incomingEntry.cost_price || 0),
      mrp: Number(incomingEntry.mrp || 0),
      rounding_adjustment: 0,
    })
  }

  function openCategoryDialog(itemKey: string) {
    setCategoryTargetKey(itemKey)
    setNewCategoryName('')
    setCategoryDialogOpen(true)
  }

  function openBrandDialog(itemKey: string) {
    setBrandTargetKey(itemKey)
    setNewBrandName('')
    setBrandDialogOpen(true)
  }

  function saveQuickCategory() {
    const cleanName = newCategoryName.trim()
    if (!cleanName) {
      toast.push('Category name is required', 'error')
      return
    }
    createCategoryM.mutate(cleanName)
  }

  function saveQuickBrand() {
    const cleanName = newBrandName.trim()
    if (!cleanName) {
      toast.push('Brand name is required', 'error')
      return
    }
    createBrandM.mutate(cleanName)
  }

  function cleanEditItems() {
    return editItems.map(({ key, existing_stock_movement_id, ...item }) => ({
      ...item,
      product_name: item.product_name.trim(),
      alias: item.alias?.trim() || undefined,
      brand: item.brand?.trim() || undefined,
      expiry_date: item.expiry_date?.trim() || undefined,
      gst_percent: 0,
      rounding_adjustment: Number(item.rounding_adjustment || 0),
      parent_unit_name: item.parent_unit_name?.trim() || undefined,
      child_unit_name: item.child_unit_name?.trim() || undefined,
    }))
  }

  function saveHeaderEdit() {
    if (!selectedPurchaseId || !editPartyId) return
    updateM.mutate({
      id: selectedPurchaseId,
      payload: {
        party_id: editPartyId,
        invoice_number: editInvoiceNumber.trim(),
        invoice_date: editInvoiceDate,
        notes: editNotes.trim() || undefined,
        discount_amount: Number(editDiscountAmount || 0),
        gst_amount: 0,
        rounding_adjustment: Number(editRoundingAdjustment || 0),
      },
    })
  }

  function saveItemEdit() {
    if (!selectedPurchaseId) return
    const cleaned = cleanEditItems()
    if (cleaned.some((item) => !item.product_name)) {
      toast.push('Every line needs a product name', 'error')
      return
    }
    replaceItemsM.mutate({ id: selectedPurchaseId, items: cleaned })
  }

  function editItemEditor() {
    return (
      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          justifyContent="space-between"
          alignItems={{ md: 'center' }}
          gap={1}
          sx={{ px: 2, py: 1.5, bgcolor: 'rgba(31,107,74,0.05)', borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Box>
            <Typography variant="subtitle1" fontWeight={700}>Product Lines</Typography>
            <Typography variant="caption" color="text.secondary">
              {editItems.length} line{editItems.length === 1 ? '' : 's'} · Lines net {money(editItemsSubtotal)} · Free qty reduces average rate
            </Typography>
          </Box>
          <Stack direction="row" gap={1}>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setEditItems((prev) => [...prev, makeEmptyItem()])}>Add Line</Button>
          </Stack>
        </Stack>

        <Stack divider={<Divider flexItem />} sx={{ p: 0 }}>
          {editItems.map((item, index) => (
            <Box key={item.key} sx={{ p: 1.5 }}>
              <Stack gap={1.25}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                  <Stack direction="row" gap={1} alignItems="center">
                    <Chip size="small" label={`Line ${index + 1}`} />
                    {item.existing_inventory_item_id ? (
                      <Chip
                        size="small"
                        color="info"
                        icon={<Inventory2OutlinedIcon />}
                        label={`Existing #${item.existing_inventory_item_id}${item.existing_stock_movement_id ? ` / In #${item.existing_stock_movement_id}` : ''}`}
                        variant="outlined"
                      />
                    ) : null}
                    <Typography variant="caption" color="text.secondary">
                      {item.product_name || 'New product line'}
                    </Typography>
                  </Stack>
                  <Button
                    color="error"
                    size="small"
                    startIcon={<DeleteIcon />}
                    onClick={() => setEditItems((prev) => (prev.length === 1 ? prev : prev.filter((row) => row.key !== item.key)))}
                  >
                    Remove
                  </Button>
                </Stack>
                <Grid container spacing={1.25} alignItems="center">
                  <Grid item xs={12} md={4}>
                    <Autocomplete
                      size="small"
                      options={inventoryBatches}
                      filterOptions={(options) => options}
                      value={
                        inventoryBatches.find((entry) => Number(entry.movement_id) === Number(item.existing_stock_movement_id)) ||
                        inventoryBatches.find((entry) => Number(entry.item_id) === Number(item.existing_inventory_item_id)) ||
                        null
                      }
                      isOptionEqualToValue={(option, value) => Number(option.movement_id) === Number(value.movement_id)}
                      getOptionLabel={incomingEntryLabel}
                      onInputChange={(_, value) => setInventorySearch(value)}
                      onChange={(_, value) => {
                        if (value) applyExistingInventory(item.key, value)
                        else patchEditItem(item.key, { existing_inventory_item_id: undefined, existing_stock_movement_id: undefined })
                      }}
                      renderOption={(props, option) => (
                        <li {...props} key={option.movement_id}>
                          <Stack gap={0.25} sx={{ width: '100%' }}>
                            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                              <Typography variant="body2" fontWeight={700}>#{option.item_id}</Typography>
                              <Chip size="small" color="success" label={`+${Number(option.delta || 0)}`} />
                              <Typography variant="body2">{option.name}{option.brand ? ` | ${option.brand}` : ''}</Typography>
                            </Stack>
                            <Typography variant="caption" color="text.secondary">
                              Incoming {fmtDate(option.incoming_at)} | Exp {option.expiry_date || '-'} | MRP {money(option.mrp)} | Current {Number(option.stock || 0)} | {option.reason}
                            </Typography>
                          </Stack>
                        </li>
                      )}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          label="Attach Existing Batch"
                          helperText="Incoming stock from 01 Apr 2026 onward"
                          fullWidth
                        />
                      )}
                    />
                  </Grid>
                  <Grid item xs={12} md={3.5}>
                    <Autocomplete
                      size="small"
                      options={products}
                      getOptionLabel={(option) => `${option.name}${option.brand ? ` | ${option.brand}` : ''}`}
                      onInputChange={(_, value) => setProductSearch(value)}
                      onChange={(_, value) => applyProduct(item.key, value)}
                      renderInput={(params) => <TextField {...params} label="Pick Product" fullWidth />}
                    />
                  </Grid>
                  <Grid item xs={12} md={3.5}>
                    <TextField size="small" label="Product Name" value={item.product_name} onChange={(e) => patchEditItem(item.key, { product_name: e.target.value, product_id: undefined, existing_inventory_item_id: undefined, existing_stock_movement_id: undefined })} fullWidth />
                  </Grid>
                  <Grid item xs={12} md={2}>
                    <Stack direction="row" gap={1}>
                      <Autocomplete
                        freeSolo
                        size="small"
                        options={brandNames}
                        value={item.brand || ''}
                        onChange={(_, value) => patchEditItem(item.key, { brand: typeof value === 'string' ? value : value || '', product_id: undefined, existing_inventory_item_id: undefined })}
                        onInputChange={(_, value) => patchEditItem(item.key, { brand: value, product_id: undefined, existing_inventory_item_id: undefined })}
                        renderInput={(params) => <TextField {...params} label="Brand" fullWidth />}
                        sx={{ flex: 1 }}
                      />
                      <Button size="small" variant="outlined" onClick={() => openBrandDialog(item.key)} sx={{ minWidth: 0, px: 1 }}>
                        New
                      </Button>
                    </Stack>
                  </Grid>
                  <Grid item xs={12} md={1.5}>
                    <TextField size="small" label="Alias" value={item.alias || ''} onChange={(e) => patchEditItem(item.key, { alias: e.target.value })} fullWidth />
                  </Grid>
                  <Grid item xs={12} md={2}>
                    <Stack direction="row" gap={1}>
                      <TextField size="small" select label="Category" value={item.category_id ?? ''} onChange={(e) => patchEditItem(item.key, { category_id: e.target.value ? Number(e.target.value) : undefined })} fullWidth>
                        <MenuItem value="">None</MenuItem>
                        {categories.map((category) => (
                          <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>
                        ))}
                      </TextField>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => openCategoryDialog(item.key)}
                        sx={{ minWidth: 0, px: 1 }}
                      >
                        New
                      </Button>
                    </Stack>
                  </Grid>

                  <Grid item xs={12}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>
                      Batch, quantity, and invoice math
                    </Typography>
                  </Grid>
                  <Grid item xs={6} md={1.6}>
                    <TextField size="small" label="Expiry" type="date" value={item.expiry_date || ''} onChange={(e) => patchEditItem(item.key, { expiry_date: e.target.value })} InputLabelProps={{ shrink: true }} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1}>
                    <TextField size="small" label="Rack" type="number" value={item.rack_number ?? 0} onChange={(e) => patchEditItem(item.key, { rack_number: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1}>
                    <TextField size="small" label="Qty" type="number" value={item.sealed_qty} onChange={(e) => patchEditItem(item.key, { sealed_qty: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1}>
                    <TextField size="small" label="Free" type="number" value={item.free_qty || 0} onChange={(e) => patchEditItem(item.key, { free_qty: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="Rate" type="number" value={item.cost_price} onChange={(e) => patchEditItem(item.key, { cost_price: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="MRP" type="number" value={item.mrp} onChange={(e) => patchEditItem(item.key, { mrp: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="Discount" type="number" value={item.discount_amount || 0} onChange={(e) => patchEditItem(item.key, { discount_amount: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="Round Off" type="number" value={item.rounding_adjustment || 0} onChange={(e) => patchEditItem(item.key, { rounding_adjustment: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={12} md={2.8}>
                    <Stack gap={0.75}>
                      <Stack direction="row" gap={1} alignItems="center" justifyContent="space-between">
                        <FormControlLabel
                          control={<Checkbox size="small" checked={Boolean(item.loose_sale_enabled)} onChange={(e) => patchEditItem(item.key, { loose_sale_enabled: e.target.checked })} />}
                          label="Loose"
                          sx={{ m: 0 }}
                        />
                        <Typography variant="subtitle2" sx={{ minWidth: 80, textAlign: 'right' }}>
                          {money(lineBaseTotal(item))}
                        </Typography>
                      </Stack>
                      <Stack direction="row" gap={0.75} flexWrap="wrap">
                        <Chip size="small" label={`Gross ${money(lineGrossTotal(item))}`} variant="outlined" />
                        <Chip size="small" label={`Total Inward ${Number(item.sealed_qty || 0) + Number(item.free_qty || 0)}`} variant="outlined" />
                        <Chip
                          size="small"
                          color={Number(item.free_qty || 0) > 0 ? 'success' : 'default'}
                          label={`Avg Rate ${money(lineEffectiveCost(item))}`}
                          variant={Number(item.free_qty || 0) > 0 ? 'filled' : 'outlined'}
                        />
                      </Stack>
                    </Stack>
                  </Grid>
                  {item.loose_sale_enabled && (
                    <>
                      <Grid item xs={12} md={4}>
                        <TextField size="small" label="Parent Unit" value={item.parent_unit_name || ''} onChange={(e) => patchEditItem(item.key, { parent_unit_name: e.target.value })} fullWidth />
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <TextField size="small" label="Child Unit" value={item.child_unit_name || ''} onChange={(e) => patchEditItem(item.key, { child_unit_name: e.target.value })} fullWidth />
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <TextField size="small" label="Conversion Qty" type="number" value={item.conversion_qty || ''} onChange={(e) => patchEditItem(item.key, { conversion_qty: e.target.value ? Number(e.target.value) : undefined })} fullWidth />
                      </Grid>
                    </>
                  )}
                </Grid>
              </Stack>
            </Box>
          ))}
        </Stack>
      </Paper>
    )
  }

  return (
    <Stack gap={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
        <Typography variant="h5">Supplier Ledger</Typography>
        <Button
          variant="contained"
          startIcon={<PaymentsIcon />}
          onClick={() => openPaymentDialog()}
          disabled={!partyId || openPurchases.length === 0}
        >
          Add Payment
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <TextField
          select
          label="Supplier"
          value={partyId ?? ''}
          onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : null)}
          fullWidth
        >
          {suppliers.map((supplier) => (
            <MenuItem key={supplier.id} value={supplier.id}>{supplier.name}</MenuItem>
          ))}
        </TextField>
      </Paper>

      {partyId && (
        <Paper sx={{ p: 2 }}>
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Chip label={`Opening: Rs ${money(openingBalance)}`} />
            <Chip label={`Purchases: Rs ${money(totals.totalPurchases)}`} variant="outlined" />
            <Chip label={`Paid: Rs ${money(totals.totalPaid)}`} color="success" variant="outlined" />
            <Chip label={`Write-off: Rs ${money(totals.totalWriteoff)}`} variant="outlined" />
            <Chip label={`Closing: Rs ${money(totals.closingBalance)}`} color="primary" />
          </Stack>
        </Paper>
      )}

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Particulars</th>
                <th>Op Bal</th>
                <th>Purchase</th>
                <th>Paid</th>
                <th>Write-off</th>
                <th>Cl Bal</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.map((row) => {
                const purchase = purchases.find((entry) => Number(entry.id) === Number(row.purchaseId)) || null
                const canAddForRow = row.type === 'PURCHASE' && purchase && outstandingOf(purchase) > 0.0001
                return (
                  <tr key={row.id}>
                    <td>{row.date}</td>
                    <td>
                      <Stack gap={0.2}>
                        <Link
                          component="button"
                          underline="hover"
                          onClick={() => setSelectedPurchaseId(Number(row.purchaseId))}
                          sx={{ fontWeight: 800, textAlign: 'left' }}
                        >
                          {row.particulars}
                        </Link>
                        <Typography variant="caption" color="text.secondary">
                          Purchase #{row.purchaseId}
                          {row.paymentId ? ` | Payment #${row.paymentId}` : ''}
                          {row.mode ? ` | ${row.mode}` : ''}
                        </Typography>
                      </Stack>
                    </td>
                    <td>{money(row.balanceBefore)}</td>
                    <td>{row.purchaseAmount ? money(row.purchaseAmount) : '-'}</td>
                    <td>{row.paidAmount ? money(row.paidAmount) : '-'}</td>
                    <td>{row.writeoffAmount ? money(row.writeoffAmount) : '-'}</td>
                    <td>{money(row.balanceAfter)}</td>
                    <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.note || '-'}</td>
                    <td>
                      {canAddForRow ? (
                        <Button size="small" variant="outlined" onClick={() => openPaymentDialog(purchase)}>
                          Add Payment
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
              {ledgerRows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Box p={2} color="text.secondary">
                      {partyId ? 'No purchase ledger rows for this supplier yet.' : 'Select a supplier to view the ledger.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={paymentOpen} onClose={() => setPaymentOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>Add Supplier Payment</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ pt: 1 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <TextField
                select
                label="Type"
                value={paymentType}
                onChange={(e) => {
                  const next = e.target.value as 'payment' | 'writeoff'
	                  setPaymentType(next)
	                  if (next === 'writeoff') {
	                    setPaymentCash('0')
	                    setPaymentOnline('0')
	                  } else {
	                    setPaymentMode('cash')
	                  }
	                }}
	                fullWidth
	              >
	                <MenuItem value="payment">Payment</MenuItem>
                <MenuItem value="writeoff">Write-off</MenuItem>
              </TextField>
              {paymentType === 'payment' && (
                <TextField
                  select
                  label="Mode"
                  value={paymentMode}
                  onChange={(e) => setModeAndAmounts(e.target.value as 'cash' | 'online' | 'split')}
                  fullWidth
                >
                  <MenuItem value="cash">Cash</MenuItem>
                  <MenuItem value="online">Online</MenuItem>
	                  <MenuItem value="split">Split</MenuItem>
	                </TextField>
	              )}
	              <TextField
	                label="Date"
	                type="date"
	                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
            </Stack>

            <TextField
              label="Note"
              value={paymentNote}
              onChange={(e) => setPaymentNote(e.target.value)}
              fullWidth
              multiline
              minRows={2}
            />

            <Typography variant="h6">Purchase Allocations</Typography>
            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Purchase</th>
                    <th>Date</th>
                    <th>Total</th>
                    <th>Outstanding</th>
                    <th>Apply Now</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {openPurchases.map((purchase) => (
                    <tr key={purchase.id}>
                      <td>
                        <Link
                          component="button"
                          underline="hover"
                          onClick={() => setSelectedPurchaseId(Number(purchase.id))}
                          sx={{ fontWeight: 700 }}
                        >
                          {purchase.invoice_number || `#${purchase.id}`}
                        </Link>
                      </td>
                      <td>{purchase.invoice_date}</td>
                      <td>{money(purchase.total_amount)}</td>
                      <td>{money(outstandingOf(purchase))}</td>
                      <td>
                        <TextField
                          type="number"
                          value={allocationDrafts[Number(purchase.id)] ?? '0'}
                          onChange={(e) => setDraft(Number(purchase.id), e.target.value)}
                          inputProps={{ min: 0, max: money(outstandingOf(purchase)), step: '0.01' }}
                          error={Boolean(allocationIssueByPurchaseId[Number(purchase.id)])}
                          helperText={allocationIssueByPurchaseId[Number(purchase.id)] || `Max ${money(outstandingOf(purchase))}`}
                          sx={{ width: 140 }}
                        />
                      </td>
                      <td>
                        <Button size="small" onClick={() => applyFullOutstanding(purchase)}>
                          Full
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {openPurchases.length === 0 && (
                    <tr>
                      <td colSpan={6}>
                        <Box p={2} color="text.secondary">No open purchases to settle.</Box>
                      </td>
                    </tr>
                  )}
                </tbody>
	              </table>
	            </Box>

	            {paymentType === 'payment' && paymentMode === 'split' ? (
	              <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
	                <TextField
	                  label="Cash Split"
	                  type="number"
	                  value={paymentCash}
	                  onChange={(e) => setSplitCashAmount(e.target.value)}
	                  inputProps={{ min: 0, max: money(allocationTotal), step: '0.01' }}
	                  error={splitPaymentInvalid || Math.abs(allocationDifference) > 0.01}
	                  fullWidth
	                />
	                <TextField
	                  label="Online Split"
	                  type="number"
	                  value={paymentOnline}
	                  onChange={(e) => setSplitOnlineAmount(e.target.value)}
	                  inputProps={{ min: 0, max: money(allocationTotal), step: '0.01' }}
	                  error={splitPaymentInvalid || Math.abs(allocationDifference) > 0.01}
	                  fullWidth
	                />
	              </Stack>
	            ) : null}

	            <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
	              <Typography>Applied Total: {money(allocationTotal)}</Typography>
	              {paymentType === 'payment' ? (
	                <>
	                  <Typography>Cash: {money(supplierPaymentCash)}</Typography>
	                  <Typography>Online: {money(supplierPaymentOnline)}</Typography>
	                </>
	              ) : null}
	              {paymentMode === 'split' ? (
	                <Typography fontWeight={700} color={!hasAllocationIssues && !splitPaymentInvalid && Math.abs(allocationDifference) <= 0.01 ? 'text.primary' : 'warning.main'}>
	                  Difference: {money(allocationDifference)}
	                </Typography>
	              ) : null}
	            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPaymentOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => addPaymentM.mutate()} disabled={!canSavePayment || addPaymentM.isPending}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(selectedPurchaseId)} onClose={() => setSelectedPurchaseId(null)} fullWidth maxWidth="lg">
        <DialogTitle>Purchase Detail {selectedPurchase?.invoice_number ? `- ${selectedPurchase.invoice_number}` : ''}</DialogTitle>
        <DialogContent dividers>
          {!selectedPurchase ? (
            <Typography color="text.secondary">Loading purchase...</Typography>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Box>
                  <Typography variant="h6">{selectedPurchase.invoice_number || `Purchase #${selectedPurchase.id}`}</Typography>
                  <Typography color="text.secondary">{selectedSupplier?.name || `Supplier #${selectedPurchase.party_id}`} | {selectedPurchase.invoice_date}</Typography>
                </Box>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  <Button variant="outlined" startIcon={<EditIcon />} onClick={openEditHeader}>
                    Edit Header
                  </Button>
                  <Button variant="outlined" startIcon={<EditIcon />} onClick={openEditItems}>
                    Edit Items
                  </Button>
                  {outstandingOf(selectedPurchase) > 0.0001 ? (
                    <Button variant="contained" startIcon={<PaymentsIcon />} onClick={() => openPaymentDialog(selectedPurchase)}>
                      Add Payment
                    </Button>
                  ) : null}
                </Stack>
              </Stack>

              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
                  <Typography>Total: {money(selectedPurchase.total_amount)}</Typography>
                  <Typography>Paid: {money(selectedPurchase.paid_amount)}</Typography>
                  <Typography>Write-off: {money(selectedPurchase.writeoff_amount)}</Typography>
                  <Typography fontWeight={700}>Outstanding: {money(outstandingOf(selectedPurchase))}</Typography>
                  <Typography>Status: {selectedPurchase.payment_status}</Typography>
                </Stack>
                {selectedPurchase.notes ? <Typography mt={2} color="text.secondary">Notes: {selectedPurchase.notes}</Typography> : null}
              </Paper>

              <Typography variant="h6">Items</Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Source</th>
                      <th>Brand</th>
                      <th>Expiry</th>
                      <th>Qty</th>
                      <th>Free</th>
                      <th>Rate</th>
                      <th>MRP</th>
                      <th>Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedPurchase.items || []).map((item) => (
                      <tr key={item.id}>
                        <td>{item.product_name}</td>
                        <td>{item.stock_source === 'ATTACHED' ? `Existing #${item.inventory_item_id || '-'}` : 'New'}</td>
                        <td>{item.brand || '-'}</td>
                        <td>{item.expiry_date || '-'}</td>
                        <td>{item.sealed_qty}</td>
                        <td>{item.free_qty}</td>
                        <td>{money(item.cost_price)}</td>
                        <td>{money(item.mrp)}</td>
                        <td>{money(item.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>

              <Divider />

              <Typography variant="h6">Payments & Write-offs</Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Type</th>
                      <th>Mode</th>
                      <th>Cash</th>
                      <th>Online</th>
                      <th>Amount</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedPurchase.payments || []).map((payment) => (
                      <tr key={payment.id}>
                        <td>{dateOnly(payment.paid_at)}</td>
                        <td>{payment.is_writeoff ? 'Write-off' : 'Payment'}</td>
                        <td>{paymentModeLabel(payment.mode)}</td>
                        <td>{payment.is_writeoff ? '-' : money(payment.cash_amount)}</td>
                        <td>{payment.is_writeoff ? '-' : money(payment.online_amount)}</td>
                        <td>{money(payment.amount)}</td>
                        <td>{payment.note || '-'}</td>
                      </tr>
                    ))}
                    {(selectedPurchase.payments || []).length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <Box p={2} color="text.secondary">No payments yet.</Box>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedPurchaseId(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={editHeaderOpen} onClose={() => setEditHeaderOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>
          <Box>
            <Typography variant="h6">Edit Purchase</Typography>
            <Typography variant="body2" color="text.secondary">
              {editPartyId ? supplierNameFor(editPartyId) : 'Select supplier'} | {editInvoiceDate || 'No date'}
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Supplier & Invoice</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <TextField
                    select
                    label="Supplier"
                    value={editPartyId ?? ''}
                    onChange={(e) => setEditPartyId(e.target.value ? Number(e.target.value) : null)}
                    fullWidth
                  >
                    {suppliers.map((supplier) => (
                      <MenuItem key={supplier.id} value={supplier.id}>{supplier.name}</MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField label="Invoice Number" value={editInvoiceNumber} onChange={(e) => setEditInvoiceNumber(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField label="Invoice Date" type="date" value={editInvoiceDate} onChange={(e) => setEditInvoiceDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
                </Grid>
                <Grid item xs={12}>
                  <TextField label="Notes" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} multiline minRows={2} fullWidth />
                </Grid>
              </Grid>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Bill Adjustments</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={6}>
                  <TextField label="Invoice Discount" type="number" value={editDiscountAmount} onChange={(e) => setEditDiscountAmount(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField label="Final Round Off" type="number" value={editRoundingAdjustment} onChange={(e) => setEditRoundingAdjustment(e.target.value)} fullWidth />
                </Grid>
              </Grid>
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditHeaderOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveHeaderEdit} disabled={updateM.isPending || !editPartyId}>
            Save Changes
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={editItemsOpen} onClose={() => setEditItemsOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={1}>
            <Box>
              <Typography variant="h6">Edit Purchase Items</Typography>
              <Typography variant="body2" color="text.secondary">Only allowed while purchase stock is untouched.</Typography>
            </Box>
            <Chip label={`${editItems.length} line${editItems.length === 1 ? '' : 's'}`} />
          </Stack>
        </DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            {editItemEditor()}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditItemsOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveItemEdit} disabled={replaceItemsM.isPending}>
            Save Items
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={categoryDialogOpen} onClose={() => setCategoryDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Product Category</DialogTitle>
        <DialogContent dividers>
          <TextField label="Category Name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} fullWidth autoFocus />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCategoryDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuickCategory} disabled={createCategoryM.isPending}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={brandDialogOpen} onClose={() => setBrandDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Product Brand</DialogTitle>
        <DialogContent dividers>
          <TextField label="Brand Name" value={newBrandName} onChange={(e) => setNewBrandName(e.target.value)} fullWidth autoFocus />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBrandDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuickBrand} disabled={createBrandM.isPending}>Save</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
