import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
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
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import PaymentsIcon from '@mui/icons-material/Payments'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { createParty, fetchParties } from '../../services/parties'
import { listIncomingStockEntries, type IncomingStockEntry } from '../../services/inventory'
import { createBrand, createCategory, fetchBrands, fetchCategories, fetchProducts } from '../../services/products'
import {
  addPurchasePayment,
  cancelPurchase,
  createPurchase,
  deletePurchasePayment,
  fetchPurchase,
  fetchPurchases,
  fetchSupplierLedger,
  replacePurchaseItems,
  restorePurchasePayment,
  fetchSupplierLedgerSummary,
  updatePurchasePayment,
  updatePurchase,
} from '../../services/purchases'
import type { Category, Party, Product, Purchase, PurchaseItemPayload, PurchasePayment, PurchasePaymentPayload } from '../../lib/types'
import { PRODUCT_SEARCH_MIN_CHARS, PRODUCT_SEARCH_PROMPT } from '../../lib/constants'
import { useToast } from '../../components/ui/Toaster'

type DraftItem = PurchaseItemPayload & { key: string; existing_stock_movement_id?: number }
type DraftPayment = PurchasePaymentPayload & { key: string; paid_at: string; is_deleted?: boolean }

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

function money(n: number) {
  return Number(n || 0).toFixed(2)
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

function movementReasonLabel(reason?: string | null) {
  const key = String(reason || '').toUpperCase()
  const labels: Record<string, string> = {
    INVENTORY_ADD: 'Inventory Add',
    OPENING: 'Opening',
    PURCHASE: 'Purchase',
    ADJUST: 'Stock Adjust',
    RETURN: 'Return',
    EXCHANGE_IN: 'Exchange Return',
    PACK_OPEN_IN: 'Pack Open In',
  }
  return labels[key] || key || '-'
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
    movementReasonLabel(entry.reason),
  ].filter(Boolean)
  return parts.join(' | ')
}

function fmtDateTime(v?: string | null) {
  if (!v) return '-'
  try {
    return new Date(v).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return String(v)
  }
}

export default function PurchasesPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const today = new Date().toISOString().slice(0, 10)

  const [filterPartyId, setFilterPartyId] = useState<number | null>(null)
  const [filterFromDate, setFilterFromDate] = useState('')
  const [filterToDate, setFilterToDate] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [partyId, setPartyId] = useState<number | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(today)
  const [notes, setNotes] = useState('')
  const [discountAmount, setDiscountAmount] = useState('0')
  const [roundingAdjustment, setRoundingAdjustment] = useState('0')
  const [items, setItems] = useState<DraftItem[]>([makeEmptyItem()])
  const [draftPayments, setDraftPayments] = useState<DraftPayment[]>([])
  const [editingDraftPaymentKey, setEditingDraftPaymentKey] = useState<string | null>(null)
  const [paymentContext, setPaymentContext] = useState<'saved' | 'draft'>('saved')
  const [expandedDraftLines, setExpandedDraftLines] = useState<Record<string, boolean>>({})
  const [expandedEditLines, setExpandedEditLines] = useState<Record<string, boolean>>({})

  const [productSearch, setProductSearch] = useState('')
  const [inventorySearch, setInventorySearch] = useState('')
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<number | null>(null)
  const [editHeaderOpen, setEditHeaderOpen] = useState(false)
  const [editItemsOpen, setEditItemsOpen] = useState(false)
  const [editItems, setEditItems] = useState<DraftItem[]>([makeEmptyItem()])
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentPurchaseId, setPaymentPurchaseId] = useState<number | null>(null)
  const [paymentHistoryPurchaseId, setPaymentHistoryPurchaseId] = useState<number | null>(null)
  const [editingPayment, setEditingPayment] = useState<PurchasePayment | null>(null)
  const [deletePaymentTarget, setDeletePaymentTarget] = useState<{ purchase: Purchase; payment: PurchasePayment } | null>(null)
  const [paymentAmount, setPaymentAmount] = useState('0')
  const [paymentMode, setPaymentMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [paymentCash, setPaymentCash] = useState('0')
  const [paymentOnline, setPaymentOnline] = useState('0')
  const [paymentDate, setPaymentDate] = useState(today)
  const [paymentNote, setPaymentNote] = useState('')
  const [paymentType, setPaymentType] = useState<'payment' | 'writeoff'>('payment')
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const productSearchTerm = productSearch.trim()
  const canSearchProducts = productSearchTerm.length >= PRODUCT_SEARCH_MIN_CHARS
  const inventorySearchTerm = inventorySearch.trim()
  const canSearchInventoryBatches = inventorySearchTerm.length >= PRODUCT_SEARCH_MIN_CHARS

  const [editPartyId, setEditPartyId] = useState<number | null>(null)
  const [editInvoiceNumber, setEditInvoiceNumber] = useState('')
  const [editInvoiceDate, setEditInvoiceDate] = useState(today)
  const [editNotes, setEditNotes] = useState('')
  const [editDiscountAmount, setEditDiscountAmount] = useState('0')
  const [editRoundingAdjustment, setEditRoundingAdjustment] = useState('0')

  const [supplierDialogOpen, setSupplierDialogOpen] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierPhone, setNewSupplierPhone] = useState('')
  const [newSupplierGst, setNewSupplierGst] = useState('')
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [categoryTargetKey, setCategoryTargetKey] = useState<string | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [brandDialogOpen, setBrandDialogOpen] = useState(false)
  const [brandTargetKey, setBrandTargetKey] = useState<string | null>(null)
  const [newBrandName, setNewBrandName] = useState('')

  const suppliersQ = useQuery<Party[], Error>({
    queryKey: ['suppliers-select'],
    queryFn: () => fetchParties({ party_group: 'SUNDRY_CREDITOR', is_active: true }),
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
    queryKey: ['purchase-products', productSearchTerm],
    queryFn: () => fetchProducts({ q: productSearchTerm }),
    enabled: canSearchProducts,
  })

  const inventoryBatchesQ = useQuery<IncomingStockEntry[], Error>({
    queryKey: ['purchase-existing-inventory', inventorySearchTerm, EXISTING_INVENTORY_FROM_DATE],
    queryFn: () => listIncomingStockEntries(inventorySearchTerm, {
      include_archived: true,
      incoming_from: EXISTING_INVENTORY_FROM_DATE,
    }),
    enabled: canSearchInventoryBatches,
  })

  const purchasesQ = useQuery<Purchase[], Error>({
    queryKey: ['purchases-list', filterPartyId, filterFromDate, filterToDate],
    queryFn: () => fetchPurchases({
      party_id: filterPartyId || undefined,
      from_date: filterFromDate || undefined,
      to_date: filterToDate || undefined,
    }),
  })

  const selectedPurchaseQ = useQuery<Purchase, Error>({
    queryKey: ['purchase-detail', selectedPurchaseId],
    queryFn: () => fetchPurchase(Number(selectedPurchaseId)),
    enabled: Boolean(selectedPurchaseId),
  })

  const ledgerQ = useQuery({
    queryKey: ['supplier-ledger-summary', partyId],
    queryFn: () => fetchSupplierLedgerSummary(Number(partyId)),
    enabled: Boolean(partyId),
  })

  const supplierLedgerQ = useQuery({
    queryKey: ['supplier-ledger-quick', partyId],
    queryFn: () => fetchSupplierLedger(Number(partyId)),
    enabled: Boolean(partyId),
  })

  useEffect(() => {
    const supplierId = Number(searchParams.get('supplier_id') || 0)
    const purchaseId = Number(searchParams.get('purchase_id') || 0)
    const shouldAdd = searchParams.get('new') === '1'
    if (purchaseId > 0) setSelectedPurchaseId(purchaseId)
    if (supplierId > 0) {
      setPartyId(supplierId)
      setFilterPartyId(supplierId)
    }
    if (shouldAdd) setAddOpen(true)
    if (supplierId > 0 || shouldAdd) {
      const next = new URLSearchParams(searchParams)
      next.delete('supplier_id')
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const createM = useMutation({
    mutationFn: createPurchase,
    onSuccess: () => {
      toast.push('Purchase saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory'] })
      if (partyId) queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary', partyId] })
      resetForm()
      setAddOpen(false)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to save purchase'), 'error'),
  })

  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) => updatePurchase(id, payload),
    onSuccess: (purchase) => {
      toast.push('Purchase updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail', purchase.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      setEditHeaderOpen(false)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to update purchase'), 'error'),
  })

  const addPaymentM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) => addPurchasePayment(id, payload),
    onSuccess: (purchase) => {
      toast.push(paymentType === 'writeoff' ? 'Write-off added' : 'Payment added', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail', purchase.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-all-purchase-payments'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-all-purchase-payments'] })
      resetPaymentForm()
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to save payment'), 'error'),
  })

  const updatePaymentM = useMutation({
    mutationFn: ({ id, paymentId, payload }: { id: number; paymentId: number; payload: any }) => updatePurchasePayment(id, paymentId, payload),
    onSuccess: (purchase) => {
      toast.push('Payment updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail', purchase.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-all-purchase-payments'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-all-purchase-payments'] })
      resetPaymentForm()
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to update payment'), 'error'),
  })

  const deletePaymentM = useMutation({
    mutationFn: ({ id, paymentId }: { id: number; paymentId: number }) => deletePurchasePayment(id, paymentId),
    onSuccess: (purchase) => {
      toast.push('Payment deleted', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail', purchase.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-all-purchase-payments'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-all-purchase-payments'] })
      setDeletePaymentTarget(null)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to delete payment'), 'error'),
  })

  const restorePaymentM = useMutation({
    mutationFn: ({ id, paymentId }: { id: number; paymentId: number }) => restorePurchasePayment(id, paymentId),
    onSuccess: (purchase) => {
      toast.push('Payment restored', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail', purchase.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-summary'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook-all-purchase-payments'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-purchase-payments-day'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook-all-purchase-payments'] })
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to restore payment'), 'error'),
  })

  const cancelM = useMutation({
    mutationFn: (id: number) => cancelPurchase(id),
    onSuccess: (purchase) => {
      toast.push('Purchase cancelled', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail', purchase.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory'] })
      setCancelConfirmOpen(false)
      setSelectedPurchaseId(null)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to cancel purchase'), 'error'),
  })

  const replaceItemsM = useMutation({
    mutationFn: ({ id, items }: { id: number; items: PurchaseItemPayload[] }) => replacePurchaseItems(id, items),
    onSuccess: (purchase) => {
      toast.push('Purchase items replaced', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['purchase-detail', purchase.id] })
      queryClient.invalidateQueries({ queryKey: ['supplier-ledger-summary'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory'] })
      setEditItemsOpen(false)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to replace purchase items'), 'error'),
  })

  const createSupplierM = useMutation({
    mutationFn: createParty,
    onSuccess: (supplier) => {
      toast.push('Supplier added', 'success')
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      queryClient.invalidateQueries({ queryKey: ['suppliers-select'] })
      setPartyId(Number(supplier.id))
      setSupplierDialogOpen(false)
      setNewSupplierName('')
      setNewSupplierPhone('')
      setNewSupplierGst('')
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to add supplier'), 'error'),
  })

  const createCategoryM = useMutation({
    mutationFn: createCategory,
    onSuccess: (category) => {
      toast.push('Category added', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchase-categories'] })
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
      if (categoryTargetKey) {
        updateItem(categoryTargetKey, { category_id: Number(category.id) })
        updateEditItem(categoryTargetKey, { category_id: Number(category.id) })
      }
      setCategoryDialogOpen(false)
      setCategoryTargetKey(null)
      setNewCategoryName('')
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to add category'), 'error'),
  })

  const createBrandM = useMutation({
    mutationFn: createBrand,
    onSuccess: (brand) => {
      toast.push('Brand added', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchase-brands'] })
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
      if (brandTargetKey) {
        updateItem(brandTargetKey, { brand: brand.name, product_id: undefined, existing_inventory_item_id: undefined })
        updateEditItem(brandTargetKey, { brand: brand.name, product_id: undefined, existing_inventory_item_id: undefined })
      }
      setBrandDialogOpen(false)
      setBrandTargetKey(null)
      setNewBrandName('')
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to add brand'), 'error'),
  })

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + lineBaseTotal(item), 0),
    [items],
  )

  const total = useMemo(
    () => subtotal - Number(discountAmount || 0) + Number(roundingAdjustment || 0),
    [subtotal, discountAmount, roundingAdjustment],
  )
  const draftPaymentTotal = draftPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const draftPaidTotal = draftPayments.reduce((sum, payment) => sum + (payment.is_writeoff ? 0 : Number(payment.amount || 0)), 0)
  const draftWriteoffTotal = draftPayments.reduce((sum, payment) => sum + (payment.is_writeoff ? Number(payment.amount || 0) : 0), 0)
  const editingDraftPayment = editingDraftPaymentKey
    ? draftPayments.find((payment) => payment.key === editingDraftPaymentKey) || null
    : null
  const draftPaymentAvailableAmount = Math.max(0, total - draftPaymentTotal) + (editingDraftPayment ? Number(editingDraftPayment.amount || 0) : 0)

  const suppliers = suppliersQ.data || []
  const categories = categoriesQ.data || []
  const brandNames = (brandsQ.data || []).map((brand) => brand.name)
  const products = canSearchProducts ? productsQ.data || [] : []
  const inventoryBatches = canSearchInventoryBatches ? inventoryBatchesQ.data || [] : []
  const purchases = purchasesQ.data || []
  const selectedPurchase = selectedPurchaseQ.data || null
  const editSubtotal = Number(selectedPurchase?.subtotal_amount || 0)
  const editGstAmount = Number(selectedPurchase?.gst_amount || 0)
  const editDiscountValue = Number(editDiscountAmount || 0)
  const editRoundingValue = Number(editRoundingAdjustment || 0)
  const editBillAmount = editSubtotal - editDiscountValue + editGstAmount + editRoundingValue
  const editPaidAmount = Number(selectedPurchase?.paid_amount || 0)
  const editWriteoffAmount = Number(selectedPurchase?.writeoff_amount || 0)
  const editCoveredAmount = editPaidAmount + editWriteoffAmount
  const editOutstandingAmount = editBillAmount - editCoveredAmount
  const editBillAmountInvalid = editBillAmount < editCoveredAmount - 0.0001
  const editItemsSubtotal = editItems.reduce((sum, item) => sum + lineBaseTotal(item), 0)
  const editItemsBillAmount = editItemsSubtotal - Number(selectedPurchase?.discount_amount || 0) + Number(selectedPurchase?.gst_amount || 0) + Number(selectedPurchase?.rounding_adjustment || 0)
  const editItemsBillAmountInvalid = Boolean(selectedPurchase) && editItemsBillAmount < editCoveredAmount - 0.0001
  const selectedSupplierName = selectedPurchase
    ? suppliers.find((s) => Number(s.id) === Number(selectedPurchase.party_id))?.name || `Supplier #${selectedPurchase.party_id}`
    : ''
  const paymentTargetPurchase = paymentPurchaseId
    ? (Number(selectedPurchase?.id || 0) === Number(paymentPurchaseId) ? selectedPurchase : purchases.find((row) => Number(row.id) === Number(paymentPurchaseId)) || null)
    : selectedPurchase
  const paymentHistoryPurchase = paymentHistoryPurchaseId
    ? purchases.find((row) => Number(row.id) === Number(paymentHistoryPurchaseId))
      || (Number(selectedPurchase?.id || 0) === Number(paymentHistoryPurchaseId) ? selectedPurchase : null)
    : null
  const paymentTargetOutstanding = paymentTargetPurchase
    ? Math.max(0, Number(paymentTargetPurchase.total_amount || 0) - Number(paymentTargetPurchase.paid_amount || 0) - Number(paymentTargetPurchase.writeoff_amount || 0))
    : 0
  const paymentAvailableAmount = paymentContext === 'draft'
    ? draftPaymentAvailableAmount
    : paymentTargetOutstanding + (editingPayment && !editingPayment.is_deleted ? Number(editingPayment.amount || 0) : 0)
  const purchasePaymentCash = paymentType === 'writeoff' || paymentMode === 'online' ? 0 : Number(paymentCash || 0)
  const purchasePaymentOnline = paymentType === 'writeoff' || paymentMode === 'cash' ? 0 : Number(paymentOnline || 0)
  const purchasePaymentAmount = paymentType === 'writeoff'
    ? Number(paymentAmount || 0)
    : Number((purchasePaymentCash + purchasePaymentOnline).toFixed(2))
  const purchasePaymentPartsInvalid = paymentType === 'writeoff'
    ? Number.isNaN(purchasePaymentAmount) || purchasePaymentAmount < 0
    : Number.isNaN(purchasePaymentCash) || Number.isNaN(purchasePaymentOnline) || purchasePaymentCash < 0 || purchasePaymentOnline < 0
  const purchasePaymentError =
    purchasePaymentPartsInvalid
      ? 'Invalid amount'
      : purchasePaymentAmount <= 0
      ? 'Amount must be greater than 0'
      : purchasePaymentAmount > paymentAvailableAmount + 0.01
        ? `Max ${money(paymentAvailableAmount)}`
        : ''
  const supplierNameFor = (id: number) => suppliers.find((supplier) => Number(supplier.id) === Number(id))?.name || `Supplier #${id}`

  useEffect(() => {
    if (!paymentOpen || paymentType !== 'payment' || paymentMode !== 'split') return
    const cash = Number(paymentCash || 0)
    if (Number.isNaN(cash) || cash < 0) {
      setPaymentOnline((prev) => (prev === '0' ? prev : '0'))
    } else if (cash > paymentAvailableAmount) {
      const outstanding = money(paymentAvailableAmount)
      setPaymentCash((prev) => (prev === outstanding ? prev : outstanding))
      setPaymentOnline((prev) => (prev === '0' ? prev : '0'))
    } else {
      const online = money(paymentAvailableAmount - cash)
      setPaymentOnline((prev) => (prev === online ? prev : online))
    }
  }, [paymentAvailableAmount, paymentCash, paymentMode, paymentOpen, paymentType])

  function resetForm() {
    setPartyId(null)
    setInvoiceNumber('')
    setInvoiceDate(today)
    setNotes('')
    setDiscountAmount('0')
    setRoundingAdjustment('0')
    const firstItem = makeEmptyItem()
    setItems([firstItem])
    setDraftPayments([])
    setEditingDraftPaymentKey(null)
    setExpandedDraftLines({ [firstItem.key]: true })
  }

  function resetFilters() {
    setFilterPartyId(null)
    setFilterFromDate('')
    setFilterToDate('')
  }

  function openAddPurchase() {
    resetForm()
    setAddOpen(true)
  }

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  function updateEditItem(key: string, patch: Partial<DraftItem>) {
    setEditItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }

  function applyProduct(itemKey: string, product: Product | null, editMode = false) {
    if (!product) return
    const patch = {
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
    }
    if (editMode) updateEditItem(itemKey, patch)
    else {
      updateItem(itemKey, patch)
      setInventorySearch(product.name)
    }
  }

  function applyExistingInventory(itemKey: string, incomingEntry: IncomingStockEntry | null, editMode = false) {
    if (!incomingEntry) return
    const incomingProduct = incomingEntry.product_id
      ? products.find((product) => Number(product.id) === Number(incomingEntry.product_id))
      : null
    const patch = {
      existing_stock_movement_id: incomingEntry.movement_id,
      existing_inventory_item_id: incomingEntry.item_id,
      product_id: incomingEntry.product_id ?? undefined,
      product_name: incomingEntry.name,
      brand: incomingEntry.brand || '',
      category_id: incomingEntry.category_id ?? incomingProduct?.category_id ?? undefined,
      expiry_date: incomingEntry.expiry_date || '',
      rack_number: incomingEntry.rack_number || 0,
      sealed_qty: Math.max(1, Number(incomingEntry.delta || 0)),
      cost_price: Number(incomingEntry.cost_price || 0),
      mrp: Number(incomingEntry.mrp || 0),
      rounding_adjustment: 0,
    }
    if (editMode) updateEditItem(itemKey, patch)
    else updateItem(itemKey, patch)
  }

  function openDetail(purchaseId: number) {
    setSelectedPurchaseId(purchaseId)
  }

  function closeDetail() {
    setSelectedPurchaseId(null)
    if (searchParams.has('purchase_id')) {
      const next = new URLSearchParams(searchParams)
      next.delete('purchase_id')
      setSearchParams(next, { replace: true })
    }
  }

  function resetPaymentForm() {
    setPaymentOpen(false)
    setPaymentPurchaseId(null)
    setEditingPayment(null)
    setEditingDraftPaymentKey(null)
    setPaymentContext('saved')
    setPaymentAmount('0')
    setPaymentMode('cash')
    setPaymentCash('0')
    setPaymentOnline('0')
    setPaymentNote('')
    setPaymentType('payment')
    setPaymentDate(today)
  }

  function openPaymentDialog(purchase?: Purchase) {
    const target = purchase || selectedPurchase
    if (!target) return
    const outstanding = money(Math.max(0, Number(target.total_amount || 0) - Number(target.paid_amount || 0) - Number(target.writeoff_amount || 0)))
    setPaymentContext('saved')
    setPaymentPurchaseId(Number(target.id))
    setEditingPayment(null)
    setEditingDraftPaymentKey(null)
    setPaymentType('payment')
    setPaymentMode('cash')
    setPaymentCash(outstanding)
    setPaymentOnline('0')
    setPaymentAmount(outstanding)
    setPaymentDate(today)
    setPaymentNote('')
    setPaymentOpen(true)
  }

  function openEditPaymentDialog(purchase: Purchase, payment: PurchasePayment) {
    setPaymentContext('saved')
    setPaymentPurchaseId(Number(purchase.id))
    setEditingPayment(payment)
    setEditingDraftPaymentKey(null)
    setPaymentType(payment.is_writeoff ? 'writeoff' : 'payment')
    setPaymentMode(payment.is_writeoff ? 'cash' : (payment.mode as 'cash' | 'online' | 'split') || 'cash')
    setPaymentCash(String(Number(payment.cash_amount || 0)))
    setPaymentOnline(String(Number(payment.online_amount || 0)))
    setPaymentAmount(String(Number(payment.amount || 0)))
    setPaymentDate(String(payment.paid_at || '').slice(0, 10) || today)
    setPaymentNote(payment.note || '')
    setPaymentOpen(true)
  }

  function openDraftPaymentDialog() {
    const available = money(Math.max(0, total - draftPaymentTotal))
    setPaymentContext('draft')
    setPaymentPurchaseId(null)
    setEditingPayment(null)
    setEditingDraftPaymentKey(null)
    setPaymentType('payment')
    setPaymentMode('cash')
    setPaymentCash(available)
    setPaymentOnline('0')
    setPaymentAmount(available)
    setPaymentDate(invoiceDate || today)
    setPaymentNote('')
    setPaymentOpen(true)
  }

  function openEditDraftPaymentDialog(payment: DraftPayment) {
    setPaymentContext('draft')
    setPaymentPurchaseId(null)
    setEditingPayment(null)
    setEditingDraftPaymentKey(payment.key)
    setPaymentType(payment.is_writeoff ? 'writeoff' : 'payment')
    setPaymentMode(payment.is_writeoff ? 'cash' : (payment.mode as 'cash' | 'online' | 'split') || 'cash')
    setPaymentCash(String(Number(payment.cash_amount || 0)))
    setPaymentOnline(String(Number(payment.online_amount || 0)))
    setPaymentAmount(String(Number(payment.amount || 0)))
    setPaymentDate(String(payment.paid_at || '').slice(0, 10) || invoiceDate || today)
    setPaymentNote(payment.note || '')
    setPaymentOpen(true)
  }

  function setPaymentModeAndAmounts(next: 'cash' | 'online' | 'split') {
    setPaymentMode(next)
    const outstanding = money(paymentAvailableAmount)
    if (next === 'cash') {
      setPaymentCash(outstanding)
      setPaymentOnline('0')
    }
    if (next === 'online') {
      setPaymentCash('0')
      setPaymentOnline(outstanding)
    }
    if (next === 'split') {
      setPaymentCash(outstanding)
      setPaymentOnline('0')
    }
  }

  function setPaymentSplitCashAmount(value: string) {
    const cash = Number(value || 0)
    if (Number.isNaN(cash) || cash < 0) {
      setPaymentCash(value)
      setPaymentOnline('0')
      return
    }
    const cappedCash = Math.min(cash, paymentAvailableAmount)
    setPaymentCash(cash > paymentAvailableAmount ? money(paymentAvailableAmount) : value)
    setPaymentOnline(money(paymentAvailableAmount - cappedCash))
  }

  function setPaymentSplitOnlineAmount(value: string) {
    const online = Number(value || 0)
    if (Number.isNaN(online) || online < 0) {
      setPaymentOnline(value)
      setPaymentCash('0')
      return
    }
    const cappedOnline = Math.min(online, paymentAvailableAmount)
    setPaymentOnline(online > paymentAvailableAmount ? money(paymentAvailableAmount) : value)
    setPaymentCash(money(paymentAvailableAmount - cappedOnline))
  }

  function openEditHeader() {
    const purchase = selectedPurchaseQ.data
    if (!purchase) return
    setEditPartyId(purchase.party_id)
    setEditInvoiceNumber(purchase.invoice_number)
    setEditInvoiceDate(purchase.invoice_date)
    setEditNotes(purchase.notes || '')
    setEditDiscountAmount(String(purchase.discount_amount || 0))
    setEditRoundingAdjustment(String(purchase.rounding_adjustment || 0))
    setEditHeaderOpen(true)
  }

  function openEditItems() {
    const purchase = selectedPurchaseQ.data
    if (!purchase) return
    const nextItems = purchase.items.map((item) => ({
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
      gst_percent: item.gst_percent,
      discount_amount: item.discount_amount,
      rounding_adjustment: item.rounding_adjustment || 0,
      loose_sale_enabled: false,
      parent_unit_name: '',
      child_unit_name: '',
      conversion_qty: undefined,
    }))
    setEditItems(nextItems)
    setExpandedEditLines({})
    setEditItemsOpen(true)
  }

  function cleanItems(draftItems: DraftItem[]) {
    return draftItems.map((item) => ({
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

  function purchasePayloadItems(draftItems: DraftItem[]): PurchaseItemPayload[] {
    return cleanItems(draftItems).map(({ key, existing_stock_movement_id, ...rest }) => rest)
  }

  function submit() {
    if (!partyId) {
      toast.push('Select a supplier first', 'error')
      return
    }
    if (!invoiceNumber.trim()) {
      toast.push('Invoice number is required', 'error')
      return
    }
    const cleanedItems = cleanItems(items)
    if (cleanedItems.some((item) => !item.product_name)) {
      toast.push('Every purchase item needs a product name', 'error')
      return
    }
    if (draftPaymentTotal > total + 0.01) {
      toast.push('Payments and write-offs exceed purchase total', 'error')
      return
    }
    createM.mutate({
      party_id: partyId,
      invoice_number: invoiceNumber.trim(),
      invoice_date: invoiceDate,
      notes: notes.trim() || undefined,
      discount_amount: Number(discountAmount || 0),
      gst_amount: 0,
      rounding_adjustment: Number(roundingAdjustment || 0),
      items: purchasePayloadItems(items),
      payments: draftPayments.map((payment) => ({
        amount: Number(payment.amount || 0),
        mode: payment.mode,
        cash_amount: Number(payment.cash_amount || 0),
        online_amount: Number(payment.online_amount || 0),
        note: payment.note?.trim() || undefined,
        paid_at: payment.paid_at || invoiceDate,
        is_writeoff: Boolean(payment.is_writeoff),
      })),
    })
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

  function savePayment() {
    if (paymentContext !== 'draft' && !paymentPurchaseId) return
    if (purchasePaymentError) {
      toast.push(purchasePaymentError, 'error')
      return
    }
    const payload = {
      amount: purchasePaymentAmount,
      mode: paymentMode,
      cash_amount: purchasePaymentCash,
      online_amount: purchasePaymentOnline,
      note: paymentNote.trim(),
      paid_at: paymentDate,
      is_writeoff: paymentType === 'writeoff',
    }
    if (paymentContext === 'draft') {
      const draft: DraftPayment = {
        key: editingDraftPaymentKey || Math.random().toString(36).slice(2),
        ...payload,
        paid_at: paymentDate,
      }
      setDraftPayments((prev) => (
        editingDraftPaymentKey
          ? prev.map((payment) => (payment.key === editingDraftPaymentKey ? draft : payment))
          : [...prev, draft]
      ))
      resetPaymentForm()
      return
    }
    const targetPaymentPurchaseId = Number(paymentPurchaseId)
    if (editingPayment) {
      updatePaymentM.mutate({ id: targetPaymentPurchaseId, paymentId: Number(editingPayment.id), payload })
    } else {
      addPaymentM.mutate({ id: targetPaymentPurchaseId, payload })
    }
  }

  function saveItemReplacement() {
    if (!selectedPurchaseId) return
    const cleanedItems = cleanItems(editItems)
    if (cleanedItems.some((item) => !item.product_name)) {
      toast.push('Every replacement purchase item needs a product name', 'error')
      return
    }
    if (editItemsBillAmountInvalid) {
      toast.push('Edited items reduce total below paid/write-off amount', 'error')
      return
    }
    replaceItemsM.mutate({
      id: selectedPurchaseId,
      items: purchasePayloadItems(editItems),
    })
  }

  function saveQuickSupplier() {
    const cleanName = newSupplierName.trim()
    if (!cleanName) {
      toast.push('Supplier name is required', 'error')
      return
    }
    createSupplierM.mutate({
      name: cleanName,
      party_group: 'SUNDRY_CREDITOR',
      phone: newSupplierPhone.trim() || undefined,
      gst_number: newSupplierGst.trim() || undefined,
      opening_balance: 0,
      opening_balance_type: 'CR',
    })
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

  function itemEditor(
    draftItems: DraftItem[],
    setDraftItems: Dispatch<SetStateAction<DraftItem[]>>,
    editMode = false,
  ) {
    const patchItem = editMode ? updateEditItem : updateItem
    const expandedLines = editMode ? expandedEditLines : expandedDraftLines
    const setExpandedLines = editMode ? setExpandedEditLines : setExpandedDraftLines
    const defaultExpanded = !editMode
    const draftSubtotal = draftItems.reduce(
      (sum, item) => sum + lineBaseTotal(item),
      0,
    )
    const headerDiscount = editMode ? Number(selectedPurchase?.discount_amount || 0) : 0
    const headerGst = editMode ? Number(selectedPurchase?.gst_amount || 0) : 0
    const headerRoundOff = editMode ? Number(selectedPurchase?.rounding_adjustment || 0) : 0
    const draftBillTotal = draftSubtotal - headerDiscount + headerGst + headerRoundOff
    const draftCovered = editMode ? Number(selectedPurchase?.paid_amount || 0) + Number(selectedPurchase?.writeoff_amount || 0) : 0
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
            <Typography variant="subtitle1" fontWeight={700}>Purchase Items</Typography>
            <Typography variant="caption" color="text.secondary">
              {draftItems.length} item{draftItems.length === 1 ? '' : 's'} · Items net {money(draftSubtotal)} · Free qty reduces average rate
            </Typography>
          </Box>
          <Stack direction="row" gap={1}>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => {
                const next = makeEmptyItem()
                setDraftItems((prev) => [...prev, next])
                setExpandedLines((prev) => ({ ...prev, [next.key]: true }))
              }}
            >
              Add Item
            </Button>
          </Stack>
        </Stack>

        <Stack divider={<Divider flexItem />} sx={{ p: 0 }}>
          {draftItems.map((item, index) => {
            const isExpanded = expandedLines[item.key] ?? defaultExpanded
            return (
            <Box key={item.key} sx={{ p: 1.5, bgcolor: isExpanded ? 'background.paper' : 'grey.50' }}>
              <Stack gap={1.25}>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1} flexWrap="wrap">
                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" sx={{ minWidth: 0 }}>
                    <Chip size="small" label={`Item ${index + 1}`} />
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
                      {item.product_name || 'New purchase item'}
                    </Typography>
                    <Chip size="small" variant="outlined" label={`Qty ${Number(item.sealed_qty || 0)}`} />
                    <Chip size="small" variant="outlined" label={`Free ${Number(item.free_qty || 0)}`} />
                    <Chip size="small" variant="outlined" label={`Item Total ${money(lineBaseTotal(item))}`} />
                  </Stack>
                  <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end">
                    <Button size="small" variant="outlined" onClick={() => setExpandedLines((prev) => ({ ...prev, [item.key]: !isExpanded }))}>
                      {isExpanded ? 'Collapse' : 'Expand'}
                    </Button>
                    <Button
                      color="error"
                      size="small"
                      variant="outlined"
                      startIcon={<DeleteIcon />}
                      onClick={() => setDraftItems((prev) => (prev.length === 1 ? prev : prev.filter((row) => row.key !== item.key)))}
                    >
                      Remove
                    </Button>
                  </Stack>
                </Stack>
                {isExpanded ? (
                <Grid container spacing={1.25} alignItems="center">
                  <Grid item xs={12} md={4}>
                    <Autocomplete
                      size="small"
                      options={inventoryBatches}
                      loading={canSearchInventoryBatches && inventoryBatchesQ.isFetching}
                      filterOptions={(options) => options}
                      value={
                        inventoryBatches.find((entry) => Number(entry.movement_id) === Number(item.existing_stock_movement_id)) ||
                        inventoryBatches.find((entry) => Number(entry.item_id) === Number(item.existing_inventory_item_id)) ||
                        null
                      }
                      isOptionEqualToValue={(option, value) => Number(option.movement_id) === Number(value.movement_id)}
                      getOptionLabel={incomingEntryLabel}
                      noOptionsText={canSearchInventoryBatches ? 'No batches found' : PRODUCT_SEARCH_PROMPT}
                      onInputChange={(_, value, reason) => {
                        if (reason === 'input') setInventorySearch(value)
                        if (reason === 'clear') setInventorySearch('')
                      }}
                      onChange={(_, value) => {
                        if (value) applyExistingInventory(item.key, value, editMode)
                        else patchItem(item.key, { existing_inventory_item_id: undefined, existing_stock_movement_id: undefined })
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
                              Incoming {fmtDate(option.incoming_at)} | Exp {option.expiry_date || '-'} | MRP {money(option.mrp)} | Current {Number(option.stock || 0)} | {movementReasonLabel(option.reason)}
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
                      loading={canSearchProducts && productsQ.isFetching}
                      getOptionLabel={(option) => `${option.name}${option.brand ? ` | ${option.brand}` : ''}`}
                      filterOptions={(options) => options}
                      noOptionsText={canSearchProducts ? 'No products found' : PRODUCT_SEARCH_PROMPT}
                      onInputChange={(_, value, reason) => {
                        if (reason === 'input') setProductSearch(value)
                        if (reason === 'clear' || reason === 'reset') setProductSearch('')
                      }}
                      onChange={(_, value) => applyProduct(item.key, value, editMode)}
                      renderInput={(params) => <TextField {...params} label="Pick Product" fullWidth />}
                    />
                  </Grid>
                  <Grid item xs={12} md={3.5}>
                    <TextField size="small" label="Product Name" value={item.product_name} onChange={(e) => patchItem(item.key, { product_name: e.target.value, product_id: undefined, existing_inventory_item_id: undefined })} fullWidth />
                  </Grid>
                  <Grid item xs={12} md={2}>
                    <Stack direction="row" gap={1}>
                      <Autocomplete
                        freeSolo
                        size="small"
                        options={brandNames}
                        value={item.brand || ''}
                        onChange={(_, value) => patchItem(item.key, { brand: typeof value === 'string' ? value : value || '', product_id: undefined, existing_inventory_item_id: undefined })}
                        onInputChange={(_, value) => patchItem(item.key, { brand: value, product_id: undefined, existing_inventory_item_id: undefined })}
                        renderInput={(params) => <TextField {...params} label="Brand" fullWidth />}
                        sx={{ flex: 1 }}
                      />
                      <Button size="small" variant="outlined" onClick={() => openBrandDialog(item.key)} sx={{ minWidth: 0, px: 1 }}>
                        New
                      </Button>
                    </Stack>
                  </Grid>
                  <Grid item xs={12} md={1.5}>
                    <TextField size="small" label="Alias" value={item.alias || ''} onChange={(e) => patchItem(item.key, { alias: e.target.value })} fullWidth />
                  </Grid>
                  <Grid item xs={12} md={2}>
                    <Stack direction="row" gap={1}>
                      <TextField size="small" select label="Category" value={item.category_id ?? ''} onChange={(e) => patchItem(item.key, { category_id: e.target.value ? Number(e.target.value) : undefined })} fullWidth>
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
                    <TextField size="small" label="Expiry" type="date" value={item.expiry_date || ''} onChange={(e) => patchItem(item.key, { expiry_date: e.target.value })} InputLabelProps={{ shrink: true }} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1}>
                    <TextField size="small" label="Rack" type="number" value={item.rack_number ?? 0} onChange={(e) => patchItem(item.key, { rack_number: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1}>
                    <TextField size="small" label="Qty" type="number" value={item.sealed_qty} onChange={(e) => patchItem(item.key, { sealed_qty: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1}>
                    <TextField size="small" label="Free" type="number" value={item.free_qty || 0} onChange={(e) => patchItem(item.key, { free_qty: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="Rate" type="number" value={item.cost_price} onChange={(e) => patchItem(item.key, { cost_price: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="MRP" type="number" value={item.mrp} onChange={(e) => patchItem(item.key, { mrp: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="Discount (Rs)" type="number" value={item.discount_amount || 0} onChange={(e) => patchItem(item.key, { discount_amount: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="Round Off (+/-)" type="number" value={item.rounding_adjustment || 0} onChange={(e) => patchItem(item.key, { rounding_adjustment: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={12} md={2.8}>
                    <Stack gap={0.75}>
                      <Stack direction="row" gap={1} alignItems="center" justifyContent="space-between">
                        <FormControlLabel
                          control={<Checkbox size="small" checked={Boolean(item.loose_sale_enabled)} onChange={(e) => patchItem(item.key, { loose_sale_enabled: e.target.checked })} />}
                          label="Loose"
                          sx={{ m: 0 }}
                        />
                        <Typography variant="subtitle2" sx={{ minWidth: 80, textAlign: 'right' }}>
                          {money(lineBaseTotal(item))}
                        </Typography>
                      </Stack>
                      <Stack direction="row" gap={0.75} flexWrap="wrap">
                        <Chip
                          size="small"
                          label={`Gross ${money(lineGrossTotal(item))}`}
                          variant="outlined"
                        />
                        <Chip
                          size="small"
                          label={`Total Inward ${Number(item.sealed_qty || 0) + Number(item.free_qty || 0)}`}
                          variant="outlined"
                        />
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
                        <TextField size="small" label="Parent Unit" value={item.parent_unit_name || ''} onChange={(e) => patchItem(item.key, { parent_unit_name: e.target.value })} fullWidth />
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <TextField size="small" label="Child Unit" value={item.child_unit_name || ''} onChange={(e) => patchItem(item.key, { child_unit_name: e.target.value })} fullWidth />
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <TextField size="small" label="Conversion Qty" type="number" value={item.conversion_qty || ''} onChange={(e) => patchItem(item.key, { conversion_qty: e.target.value ? Number(e.target.value) : undefined })} fullWidth />
                      </Grid>
                    </>
                  )}
                </Grid>
                ) : null}
              </Stack>
            </Box>
            )
          })}
        </Stack>
        {editMode ? (
          <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'rgba(31,107,74,0.03)' }}>
            <Grid container spacing={2} alignItems="center">
              <Grid item xs={6} md={2}>
                <Typography variant="caption" color="text.secondary">Items Net</Typography>
                <Typography fontWeight={800}>{money(draftSubtotal)}</Typography>
              </Grid>
              <Grid item xs={6} md={2}>
                <Typography variant="caption" color="text.secondary">Header Discount (Rs)</Typography>
                <Typography fontWeight={800}>{money(headerDiscount)}</Typography>
              </Grid>
              <Grid item xs={6} md={2}>
                <Typography variant="caption" color="text.secondary">GST</Typography>
                <Typography fontWeight={800}>{money(headerGst)}</Typography>
              </Grid>
              <Grid item xs={6} md={2}>
                <Typography variant="caption" color="text.secondary">Round Off (+/-)</Typography>
                <Typography fontWeight={800}>{money(headerRoundOff)}</Typography>
              </Grid>
              <Grid item xs={6} md={2}>
                <Typography variant="caption" color="text.secondary">Bill Amount</Typography>
                <Typography variant="h6" fontWeight={900}>{money(draftBillTotal)}</Typography>
              </Grid>
              <Grid item xs={6} md={2}>
                <Typography variant="caption" color="text.secondary">Outstanding</Typography>
                <Typography fontWeight={900} color={draftBillTotal < draftCovered - 0.0001 ? 'error.main' : 'text.primary'}>
                  {money(draftBillTotal - draftCovered)}
                </Typography>
              </Grid>
            </Grid>
            {draftBillTotal < draftCovered - 0.0001 ? (
              <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                Edited items reduce the bill below paid/write-off total of {money(draftCovered)}.
              </Typography>
            ) : null}
          </Box>
        ) : null}
      </Paper>
    )
  }

  return (
    <Stack gap={2}>
      {!addOpen && !editItemsOpen ? (
      <>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h5">Purchase Desk</Typography>
          <Typography variant="body2" color="text.secondary">
            Supplier purchases, inward stock, free-item cost averaging, and settlement in one place.
          </Typography>
        </Box>
        <Button variant="contained" onClick={openAddPurchase}>Add Purchase</Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Grid container spacing={2}>
          <Grid item xs={12} md={4}>
            <TextField select label="Supplier" value={filterPartyId ?? ''} onChange={(e) => setFilterPartyId(e.target.value ? Number(e.target.value) : null)} fullWidth>
              <MenuItem value="">All</MenuItem>
              {suppliers.map((supplier) => (
                <MenuItem key={supplier.id} value={supplier.id}>{supplier.name}</MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid item xs={12} md={2.5}>
            <TextField label="From" type="date" value={filterFromDate} onChange={(e) => setFilterFromDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
          </Grid>
          <Grid item xs={12} md={2.5}>
            <TextField label="To" type="date" value={filterToDate} onChange={(e) => setFilterToDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
          </Grid>
          <Grid item xs={12} md={3}>
            <Stack direction="row" gap={1} justifyContent={{ md: 'flex-end' }}>
              <Button variant="outlined" onClick={resetFilters}>Reset Filters</Button>
              <Button variant="contained" onClick={openAddPurchase}>Add</Button>
            </Stack>
          </Grid>
        </Grid>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1} sx={{ mb: 1.5 }}>
          <Typography variant="subtitle1" fontWeight={700}>Purchase List</Typography>
          <Typography variant="body2" color="text.secondary">{purchases.length} entries</Typography>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          <Chip label={`Purchase Value ${money(purchases.reduce((sum, row) => sum + Number(row.total_amount || 0), 0))}`} />
          <Chip label={`Paid ${money(purchases.reduce((sum, row) => sum + Number(row.paid_amount || 0), 0))}`} color="success" />
          <Chip label={`Outstanding ${money(purchases.reduce((sum, row) => sum + (Number(row.total_amount || 0) - Number(row.paid_amount || 0) - Number(row.writeoff_amount || 0)), 0))}`} color="warning" />
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Supplier</th>
                <th>Invoice</th>
                <th>Date</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Write-off</th>
                <th>Status</th>
                <th>Payments</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((purchase) => {
                const activePayments = (purchase.payments || []).filter((payment) => !payment.is_deleted)
                return (
                  <tr key={purchase.id} onDoubleClick={() => openDetail(Number(purchase.id))} style={{ cursor: 'pointer' }}>
                    <td>{purchase.id}</td>
                    <td>{supplierNameFor(Number(purchase.party_id))}</td>
                    <td>{purchase.invoice_number}</td>
                    <td>{purchase.invoice_date}</td>
                    <td>{money(purchase.total_amount)}</td>
                    <td>{money(purchase.paid_amount)}</td>
                    <td>{money(purchase.writeoff_amount)}</td>
                    <td>{purchase.payment_status}</td>
                    <td>
                      <Button size="small" startIcon={<PaymentsIcon />} onClick={() => setPaymentHistoryPurchaseId(Number(purchase.id))}>
                        History ({activePayments.length})
                      </Button>
                    </td>
                    <td>
                      <Button size="small" onClick={() => openDetail(Number(purchase.id))}>Open</Button>
                    </td>
                  </tr>
                )
              })}
              {purchases.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <Box p={2} color="text.secondary">No purchases found.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>
      </>
      ) : null}

      <Dialog open={Boolean(paymentHistoryPurchaseId)} onClose={() => setPaymentHistoryPurchaseId(null)} fullWidth maxWidth="lg">
        <DialogTitle>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={1}>
            <Box>
              <Typography variant="h6">Payment / Write-off History</Typography>
              <Typography variant="body2" color="text.secondary">
                {paymentHistoryPurchase
                  ? `${supplierNameFor(Number(paymentHistoryPurchase.party_id))} | Invoice ${paymentHistoryPurchase.invoice_number}`
                  : 'Purchase payment records'}
              </Typography>
            </Box>
            {paymentHistoryPurchase ? (
              <Stack direction="row" gap={1} alignItems="center">
                <Chip label={`Outstanding ${money(Math.max(0, Number(paymentHistoryPurchase.total_amount || 0) - Number(paymentHistoryPurchase.paid_amount || 0) - Number(paymentHistoryPurchase.writeoff_amount || 0)))}`} color="warning" variant="outlined" />
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<PaymentsIcon />}
                  onClick={() => openPaymentDialog(paymentHistoryPurchase)}
                  disabled={Math.max(0, Number(paymentHistoryPurchase.total_amount || 0) - Number(paymentHistoryPurchase.paid_amount || 0) - Number(paymentHistoryPurchase.writeoff_amount || 0)) <= 0}
                >
                  Add Payment / Write-off
                </Button>
              </Stack>
            ) : null}
          </Stack>
        </DialogTitle>
        <DialogContent dividers>
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
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(paymentHistoryPurchase?.payments || []).map((payment) => (
                  <tr key={payment.id} style={{ opacity: payment.is_deleted ? 0.6 : 1 }}>
                    <td>{fmtDateTime(payment.paid_at)}</td>
                    <td>{payment.is_writeoff ? 'Write-off' : 'Payment'}</td>
                    <td>{payment.is_writeoff ? '-' : (payment.mode || 'cash')}</td>
                    <td>{payment.is_writeoff ? '-' : money(payment.cash_amount || 0)}</td>
                    <td>{payment.is_writeoff ? '-' : money(payment.online_amount || 0)}</td>
                    <td>{money(payment.amount)}</td>
                    <td>{payment.note || '-'}</td>
                    <td>{payment.is_deleted ? <Chip size="small" label="Deleted" /> : <Chip size="small" color="success" variant="outlined" label="Active" />}</td>
                    <td>
                      <Stack direction="row" gap={1}>
                        {payment.is_deleted ? (
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={!paymentHistoryPurchase || restorePaymentM.isPending}
                            onClick={() => paymentHistoryPurchase && restorePaymentM.mutate({ id: Number(paymentHistoryPurchase.id), paymentId: Number(payment.id) })}
                          >
                            Restore
                          </Button>
                        ) : (
                          <>
                            <Button size="small" variant="outlined" disabled={!paymentHistoryPurchase} onClick={() => paymentHistoryPurchase && openEditPaymentDialog(paymentHistoryPurchase, payment)}>
                              Edit
                            </Button>
                            <Button
                              size="small"
                              color="error"
                              variant="outlined"
                              disabled={!paymentHistoryPurchase}
                              onClick={() => paymentHistoryPurchase && setDeletePaymentTarget({ purchase: paymentHistoryPurchase, payment })}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </Stack>
                    </td>
                  </tr>
                ))}
                {(paymentHistoryPurchase?.payments || []).length === 0 ? (
                  <tr>
                    <td colSpan={9}>
                      <Box p={2} color="text.secondary">No payments yet.</Box>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPaymentHistoryPurchaseId(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {addOpen ? (
      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Box sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={1}>
            <Box>
              <Typography variant="h6">Add Purchase</Typography>
              <Typography variant="body2" color="text.secondary">
                {partyId ? supplierNameFor(partyId) : 'Select supplier'} | {invoiceDate || 'No date'}
              </Typography>
            </Box>
            <Stack direction="row" gap={1} alignItems="center">
              <Button variant="outlined" onClick={() => setAddOpen(false)}>Back to Purchases</Button>
              <Chip label={`Total ${money(total)}`} color="primary" />
            </Stack>
          </Stack>
        </Box>
        <Divider />
        <Box sx={{ p: 2 }}>
          <Stack gap={2}>
            {partyId && (
              <Paper variant="outlined" sx={{ p: 2, bgcolor: 'rgba(31,107,74,0.04)' }}>
                <Stack gap={1.5}>
                  <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                    <Box>
                      <Typography variant="subtitle1" fontWeight={800}>{supplierNameFor(partyId)}</Typography>
                      <Typography variant="caption" color="text.secondary">Supplier snapshot before saving this purchase</Typography>
                    </Box>
                    {ledgerQ.data ? (
                      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} flexWrap="wrap" useFlexGap>
                        <Chip label={`Purchases ${money(ledgerQ.data.total_purchases)}`} />
                        <Chip label={`Paid ${money(ledgerQ.data.total_paid)}`} color="success" variant="outlined" />
                        <Chip label={`Write-off ${money(ledgerQ.data.total_writeoff)}`} variant="outlined" />
                        <Chip label={`Outstanding ${money(ledgerQ.data.outstanding_amount)}`} color="warning" />
                      </Stack>
                    ) : (
                      <Typography variant="body2" color="text.secondary">Loading supplier summary...</Typography>
                    )}
                  </Stack>

                  {(supplierLedgerQ.data || []).length > 0 ? (
                    <Box sx={{ overflowX: 'auto' }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Recent Invoice</th>
                            <th>Date</th>
                            <th>Total</th>
                            <th>Paid</th>
                            <th>Outstanding</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(supplierLedgerQ.data || []).slice(0, 4).map((row) => (
                            <tr key={row.purchase_id}>
                              <td>{row.invoice_number}</td>
                              <td>{row.invoice_date}</td>
                              <td>{money(row.total_amount)}</td>
                              <td>{money(row.paid_amount + row.writeoff_amount)}</td>
                              <td>{money(row.outstanding_amount)}</td>
                              <td>{row.payment_status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {supplierLedgerQ.isLoading ? 'Loading recent ledger...' : 'No previous purchases for this supplier.'}
                    </Typography>
                  )}
                </Stack>
              </Paper>
            )}

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Supplier & Invoice</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <Stack direction="row" gap={1}>
                    <TextField select label="Supplier" value={partyId ?? ''} onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : null)} fullWidth>
                      {suppliers.map((supplier) => (
                        <MenuItem key={supplier.id} value={supplier.id}>{supplier.name}</MenuItem>
                      ))}
                    </TextField>
                    <Button variant="outlined" onClick={() => setSupplierDialogOpen(true)} sx={{ whiteSpace: 'nowrap' }}>New</Button>
                  </Stack>
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField label="Invoice Number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField label="Invoice Date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
                </Grid>
                <Grid item xs={12}>
                  <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} fullWidth />
                </Grid>
              </Grid>
            </Paper>

            {itemEditor(items, setItems)}

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Totals & Settlement</Typography>
              <Grid container spacing={2} alignItems="center">
                <Grid item xs={12} md={3}>
                  <Typography variant="caption" color="text.secondary">Items Net Total</Typography>
                  <Typography variant="h6">{money(subtotal)}</Typography>
                </Grid>
                <Grid item xs={12} md={3}>
                  <TextField label="Invoice Discount (Rs)" type="number" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={3}>
                  <TextField label="Final Round Off (+/-)" type="number" value={roundingAdjustment} onChange={(e) => setRoundingAdjustment(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={3}>
                  <Typography variant="caption" color="text.secondary">Total</Typography>
                  <Typography variant="h5" fontWeight={800}>{money(total)}</Typography>
                </Grid>
                <Grid item xs={12}>
                  <Paper sx={{ p: 1.5, bgcolor: 'rgba(31,107,74,0.05)' }}>
                    <Typography variant="caption" color="text.secondary">
                      Free product impact
                    </Typography>
                    <Typography variant="body2" fontWeight={700}>
                      Average rate is recalculated per item as net item amount divided by total inward quantity including free units.
                    </Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12}>
                  <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={1} sx={{ mb: 1 }}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} flexWrap="wrap" useFlexGap>
                      <Chip label={`Payments ${money(draftPaidTotal)}`} color="success" variant="outlined" />
                      <Chip label={`Write-off ${money(draftWriteoffTotal)}`} variant="outlined" />
                      <Chip label={`Outstanding ${money(Math.max(0, total - draftPaymentTotal))}`} color="warning" variant="outlined" />
                    </Stack>
                    <Button
                      variant="contained"
                      startIcon={<PaymentsIcon />}
                      onClick={openDraftPaymentDialog}
                      disabled={Math.max(0, total - draftPaymentTotal) <= 0}
                    >
                      Add Payment / Write-off
                    </Button>
                  </Stack>
                  <Box sx={{ overflowX: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Type</th>
                          <th>Mode</th>
                          <th>Cash</th>
                          <th>Online</th>
                          <th>Amount</th>
                          <th>Note</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {draftPayments.map((payment) => (
                          <tr key={payment.key}>
                            <td>{payment.paid_at || '-'}</td>
                            <td>{payment.is_writeoff ? 'Write-off' : 'Payment'}</td>
                            <td>{payment.is_writeoff ? '-' : payment.mode || 'cash'}</td>
                            <td>{payment.is_writeoff ? '-' : money(Number(payment.cash_amount || 0))}</td>
                            <td>{payment.is_writeoff ? '-' : money(Number(payment.online_amount || 0))}</td>
                            <td>{money(Number(payment.amount || 0))}</td>
                            <td>{payment.note || '-'}</td>
                            <td>
                              <Stack direction="row" gap={1}>
                                <Button size="small" variant="outlined" onClick={() => openEditDraftPaymentDialog(payment)}>Edit</Button>
                                <Button size="small" color="error" variant="outlined" onClick={() => setDraftPayments((prev) => prev.filter((row) => row.key !== payment.key))}>Delete</Button>
                              </Stack>
                            </td>
                          </tr>
                        ))}
                        {draftPayments.length === 0 ? (
                          <tr>
                            <td colSpan={8}>
                              <Box p={2} color="text.secondary">No payments added yet.</Box>
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </Box>
                  {draftPaymentTotal > total + 0.01 ? (
                    <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                      Payments and write-offs exceed purchase total by {money(draftPaymentTotal - total)}.
                    </Typography>
                  ) : null}
                </Grid>
              </Grid>
            </Paper>
          </Stack>
        </Box>
        <Stack direction="row" justifyContent="flex-end" gap={1} sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'grey.50' }}>
          <Button onClick={() => setAddOpen(false)}>Back to Purchases</Button>
          <Button variant="contained" onClick={submit} disabled={createM.isPending || draftPaymentTotal > total + 0.01}>Save Purchase</Button>
        </Stack>
      </Paper>
      ) : null}

      <Dialog open={supplierDialogOpen} onClose={() => setSupplierDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add Supplier</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <TextField label="Supplier Name" value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} required autoFocus />
            <TextField label="Phone" value={newSupplierPhone} onChange={(e) => setNewSupplierPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
            <TextField label="GST Number" value={newSupplierGst} onChange={(e) => setNewSupplierGst(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSupplierDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuickSupplier} disabled={createSupplierM.isPending}>Save Supplier</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={categoryDialogOpen} onClose={() => setCategoryDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Product Category</DialogTitle>
        <DialogContent dividers>
          <TextField label="Category Name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} required autoFocus fullWidth sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCategoryDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuickCategory} disabled={createCategoryM.isPending}>Save Category</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={brandDialogOpen} onClose={() => setBrandDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Product Brand</DialogTitle>
        <DialogContent dividers>
          <TextField label="Brand Name" value={newBrandName} onChange={(e) => setNewBrandName(e.target.value)} required autoFocus fullWidth sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBrandDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveQuickBrand} disabled={createBrandM.isPending}>Save Brand</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(selectedPurchaseId) && !editItemsOpen} onClose={closeDetail} fullWidth maxWidth="lg">
        <DialogTitle>Purchase Detail</DialogTitle>
        <DialogContent dividers>
          {!selectedPurchase && <Typography>Loading...</Typography>}
          {selectedPurchase && (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
                <Box>
                  <Typography variant="h6">{selectedPurchase.invoice_number}</Typography>
                  <Typography color="text.secondary">{selectedSupplierName} | {selectedPurchase.invoice_date}</Typography>
                </Box>
                <Stack direction="row" gap={1}>
                  <Button variant="outlined" onClick={openEditHeader}>Edit Header</Button>
                  <Button variant="outlined" onClick={openEditItems}>Edit Items</Button>
	                  <Button variant="contained" startIcon={<PaymentsIcon />} onClick={() => openPaymentDialog()}>Add Payment / Write-off</Button>
                  <Button color="error" variant="outlined" onClick={() => setCancelConfirmOpen(true)}>Cancel Purchase</Button>
                </Stack>
              </Stack>

              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
                  <Typography>Total: {money(selectedPurchase.total_amount)}</Typography>
                  <Typography>Paid: {money(selectedPurchase.paid_amount)}</Typography>
                  <Typography>Write-off: {money(selectedPurchase.writeoff_amount)}</Typography>
                  <Typography fontWeight={700}>Outstanding: {money(selectedPurchase.total_amount - selectedPurchase.paid_amount - selectedPurchase.writeoff_amount)}</Typography>
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
                      <th>Rack</th>
                      <th>Qty</th>
                      <th>Free</th>
                      <th>Rate</th>
                      <th>Avg Rate</th>
                      <th>MRP</th>
                      <th>Discount (Rs)</th>
                      <th>Round Off (+/-)</th>
                      <th>Item Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPurchase.items.map((item) => (
                      <tr key={item.id}>
                        <td>{item.product_name}</td>
                        <td>
                          {item.stock_source === 'ATTACHED'
                            ? <Chip size="small" label={`Existing #${item.inventory_item_id || '-'}`} variant="outlined" color="info" />
                            : <Chip size="small" label="New" variant="outlined" />}
                        </td>
                        <td>{item.brand || '-'}</td>
                        <td>{item.expiry_date || '-'}</td>
                        <td>{item.rack_number}</td>
                        <td>{item.sealed_qty}</td>
                        <td>{item.free_qty}</td>
                        <td>{money(item.cost_price)}</td>
                        <td>{money(item.effective_cost_price)}</td>
                        <td>{money(item.mrp)}</td>
                        <td>{money(item.discount_amount)}</td>
                        <td>{money(item.rounding_adjustment || 0)}</td>
                        <td>{money(item.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>

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
	                      <th>Status</th>
	                      <th></th>
	                    </tr>
                  </thead>
                  <tbody>
                    {selectedPurchase.payments.map((payment) => (
	                      <tr key={payment.id} style={{ opacity: payment.is_deleted ? 0.6 : 1 }}>
	                        <td>{fmtDateTime(payment.paid_at)}</td>
	                        <td>{payment.is_writeoff ? 'Write-off' : 'Payment'}</td>
	                        <td>{payment.is_writeoff ? '-' : (payment.mode || 'cash')}</td>
	                        <td>{payment.is_writeoff ? '-' : money(payment.cash_amount || 0)}</td>
	                        <td>{payment.is_writeoff ? '-' : money(payment.online_amount || 0)}</td>
	                        <td>{money(payment.amount)}</td>
	                        <td>{payment.note || '-'}</td>
	                        <td>{payment.is_deleted ? <Chip size="small" label="Deleted" /> : <Chip size="small" color="success" variant="outlined" label="Active" />}</td>
	                        <td>
	                          <Stack direction="row" gap={1}>
	                            {payment.is_deleted ? (
	                              <Button
	                                size="small"
	                                variant="outlined"
	                                disabled={restorePaymentM.isPending}
	                                onClick={() => restorePaymentM.mutate({ id: Number(selectedPurchase.id), paymentId: Number(payment.id) })}
	                              >
	                                Restore
	                              </Button>
	                            ) : (
	                              <>
	                                <Button size="small" variant="outlined" onClick={() => openEditPaymentDialog(selectedPurchase, payment)}>
	                                  Edit
	                                </Button>
	                                <Button size="small" color="error" variant="outlined" onClick={() => setDeletePaymentTarget({ purchase: selectedPurchase, payment })}>
	                                  Delete
	                                </Button>
	                              </>
	                            )}
	                          </Stack>
	                        </td>
	                      </tr>
                    ))}
                    {selectedPurchase.payments.length === 0 && (
                      <tr>
	                        <td colSpan={9}>
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
          <Button onClick={closeDetail}>Close</Button>
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
                  <TextField select label="Supplier" value={editPartyId ?? ''} onChange={(e) => setEditPartyId(e.target.value ? Number(e.target.value) : null)} fullWidth>
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
                  <TextField label="Invoice Discount (Rs)" type="number" value={editDiscountAmount} onChange={(e) => setEditDiscountAmount(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField label="Final Round Off (+/-)" type="number" value={editRoundingAdjustment} onChange={(e) => setEditRoundingAdjustment(e.target.value)} fullWidth />
                </Grid>
              </Grid>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>Bill Totals</Typography>
              <Grid container spacing={2}>
                <Grid item xs={6} md={3}>
                  <Typography variant="caption" color="text.secondary">Items Total</Typography>
                  <Typography variant="h6">{money(editSubtotal)}</Typography>
                </Grid>
                <Grid item xs={6} md={3}>
                  <Typography variant="caption" color="text.secondary">Invoice Discount (Rs)</Typography>
                  <Typography variant="h6">{money(editDiscountValue)}</Typography>
                </Grid>
                <Grid item xs={6} md={3}>
                  <Typography variant="caption" color="text.secondary">GST</Typography>
                  <Typography variant="h6">{money(editGstAmount)}</Typography>
                </Grid>
                <Grid item xs={6} md={3}>
                  <Typography variant="caption" color="text.secondary">Round Off (+/-)</Typography>
                  <Typography variant="h6">{money(editRoundingValue)}</Typography>
                </Grid>
                <Grid item xs={12} md={3}>
                  <Typography variant="caption" color="text.secondary">Bill Amount</Typography>
                  <Typography variant="h5" fontWeight={800} color={editBillAmountInvalid ? 'error.main' : 'primary.main'}>{money(editBillAmount)}</Typography>
                </Grid>
                <Grid item xs={4} md={3}>
                  <Typography variant="caption" color="text.secondary">Paid</Typography>
                  <Typography fontWeight={700}>{money(editPaidAmount)}</Typography>
                </Grid>
                <Grid item xs={4} md={3}>
                  <Typography variant="caption" color="text.secondary">Write-off</Typography>
                  <Typography fontWeight={700}>{money(editWriteoffAmount)}</Typography>
                </Grid>
                <Grid item xs={4} md={3}>
                  <Typography variant="caption" color="text.secondary">Outstanding</Typography>
                  <Typography fontWeight={800} color={editOutstandingAmount < -0.0001 ? 'error.main' : 'text.primary'}>{money(editOutstandingAmount)}</Typography>
                </Grid>
              </Grid>
              {editBillAmountInvalid ? (
                <Typography variant="body2" color="error" sx={{ mt: 1.5 }}>
                  Bill amount is below paid/write-off total of {money(editCoveredAmount)}.
                </Typography>
              ) : null}
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditHeaderOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveHeaderEdit} disabled={updateM.isPending || editBillAmountInvalid}>Save Changes</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={paymentOpen} onClose={resetPaymentForm} fullWidth maxWidth="sm">
        <DialogTitle>{editingPayment || editingDraftPaymentKey ? 'Edit Payment / Write-off' : 'Add Payment / Write-off'}</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
	            <TextField
	              select
	              label="Entry Type"
	              value={paymentType}
	              onChange={(e) => {
	                const next = e.target.value as 'payment' | 'writeoff'
	                setPaymentType(next)
	                if (next === 'writeoff') {
	                  setPaymentCash('0')
	                  setPaymentOnline('0')
	                  setPaymentAmount(money(paymentAvailableAmount))
	                } else {
	                  setPaymentMode('cash')
	                  setPaymentCash(money(paymentAvailableAmount))
	                  setPaymentOnline('0')
	                }
	              }}
	              fullWidth
	            >
	              <MenuItem value="payment">Payment</MenuItem>
	              <MenuItem value="writeoff">Write-off</MenuItem>
	            </TextField>
	            {paymentType === 'payment' ? (
	              <>
	                <TextField
	                  select
	                  label="Mode"
	                  value={paymentMode}
	                  onChange={(e) => setPaymentModeAndAmounts(e.target.value as 'cash' | 'online' | 'split')}
	                  fullWidth
	                >
	                  <MenuItem value="cash">Cash</MenuItem>
	                  <MenuItem value="online">Online</MenuItem>
	                  <MenuItem value="split">Split</MenuItem>
	                </TextField>
	                <TextField
		                  label="Cash Amount"
		                  type="number"
		                  value={paymentMode === 'online' ? '0' : paymentCash}
		                  onChange={(e) => {
		                    if (paymentMode === 'split') setPaymentSplitCashAmount(e.target.value)
		                    else setPaymentCash(e.target.value)
		                  }}
		                  disabled={paymentMode === 'online'}
		                  inputProps={{ min: 0, max: money(paymentAvailableAmount), step: '0.01' }}
		                  fullWidth
	                />
	                <TextField
		                  label="Online Amount"
		                  type="number"
		                  value={paymentMode === 'cash' ? '0' : paymentOnline}
		                  onChange={(e) => {
		                    if (paymentMode === 'split') setPaymentSplitOnlineAmount(e.target.value)
		                    else setPaymentOnline(e.target.value)
		                  }}
		                  disabled={paymentMode === 'cash'}
		                  inputProps={{ min: 0, max: money(paymentAvailableAmount), step: '0.01' }}
		                  fullWidth
	                />
	              </>
	            ) : (
	              <TextField
	                label="Amount"
	                type="number"
	                value={paymentAmount}
	                onChange={(e) => setPaymentAmount(e.target.value)}
	                inputProps={{ min: 0, max: money(paymentAvailableAmount), step: '0.01' }}
	                fullWidth
	              />
	            )}
	            <Typography variant="body2" color={purchasePaymentError ? 'error' : 'text.secondary'}>
	              Amount {money(purchasePaymentAmount)} / Available {money(paymentAvailableAmount)}
	            </Typography>
	            <TextField label="Date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            <TextField label="Note" value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} multiline minRows={2} fullWidth />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={resetPaymentForm}>Cancel</Button>
          <Button variant="contained" onClick={savePayment} disabled={addPaymentM.isPending || updatePaymentM.isPending || Boolean(purchasePaymentError)}>
            {editingPayment || editingDraftPaymentKey ? 'Save Changes' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deletePaymentTarget)} onClose={() => !deletePaymentM.isPending && setDeletePaymentTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete Payment</DialogTitle>
        <DialogContent dividers>
          <Stack gap={1}>
            <Typography>
              Delete {deletePaymentTarget?.payment.is_writeoff ? 'write-off' : 'payment'} #{deletePaymentTarget?.payment.id}?
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Invoice {deletePaymentTarget?.purchase.invoice_number || '-'} | Amount {money(Number(deletePaymentTarget?.payment.amount || 0))}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeletePaymentTarget(null)} disabled={deletePaymentM.isPending}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={!deletePaymentTarget || deletePaymentM.isPending}
            onClick={() => {
              if (!deletePaymentTarget) return
              deletePaymentM.mutate({
                id: Number(deletePaymentTarget.purchase.id),
                paymentId: Number(deletePaymentTarget.payment.id),
              })
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {editItemsOpen ? (
      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Box sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={1}>
            <Box>
              <Typography variant="h6">Edit Purchase Items</Typography>
              <Typography variant="body2" color="text.secondary">Only allowed while purchase stock is untouched.</Typography>
            </Box>
            <Stack direction="row" gap={1} alignItems="center">
              <Button variant="outlined" onClick={() => setEditItemsOpen(false)}>Back to Purchase</Button>
              <Chip label={`${editItems.length} item${editItems.length === 1 ? '' : 's'}`} />
            </Stack>
          </Stack>
        </Box>
        <Divider />
        <Box sx={{ p: 2 }}>
          <Stack gap={2}>
            {itemEditor(editItems, setEditItems, true)}
          </Stack>
        </Box>
        <Stack direction="row" justifyContent="flex-end" gap={1} sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'grey.50' }}>
          <Button onClick={() => setEditItemsOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveItemReplacement} disabled={replaceItemsM.isPending || editItemsBillAmountInvalid}>Save Items</Button>
        </Stack>
      </Paper>
      ) : null}

      <Dialog open={cancelConfirmOpen} onClose={() => setCancelConfirmOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Cancel Purchase?</DialogTitle>
        <DialogContent dividers>
          <Typography>Purchase stock must be untouched.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelConfirmOpen(false)}>Back</Button>
          <Button color="error" variant="contained" onClick={() => selectedPurchaseId && cancelM.mutate(selectedPurchaseId)} disabled={cancelM.isPending}>
            Cancel Purchase
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
