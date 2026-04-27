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
import { listItems } from '../../services/inventory'
import { createBrand, createCategory, fetchBrands, fetchCategories, fetchProducts } from '../../services/products'
import {
  addPurchasePayment,
  cancelPurchase,
  createPurchase,
  fetchPurchase,
  fetchPurchases,
  fetchSupplierLedger,
  replacePurchaseItems,
  fetchSupplierLedgerSummary,
  updatePurchase,
} from '../../services/purchases'
import type { Category, Item, Party, Product, Purchase, PurchaseItemPayload } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'

type DraftItem = PurchaseItemPayload & { key: string }

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

function currentFinancialYearStart() {
  const now = new Date()
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  return `${year}-04-01`
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

function inventoryBatchLabel(item: Item) {
  const parts = [
    `#${item.id}`,
    `Added ${fmtDate(item.created_at)}`,
    item.name,
    item.brand || '',
    item.expiry_date ? `Exp ${item.expiry_date}` : '',
    `MRP ${money(item.mrp)}`,
    `Stock ${Number(item.stock || 0)}`,
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
  const existingInventoryFromDate = currentFinancialYearStart()

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
  const [paidAmount, setPaidAmount] = useState('0')
  const [writeoffAmount, setWriteoffAmount] = useState('0')
  const [items, setItems] = useState<DraftItem[]>([makeEmptyItem()])

  const [productSearch, setProductSearch] = useState('')
  const [inventorySearch, setInventorySearch] = useState('')
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<number | null>(null)
  const [editHeaderOpen, setEditHeaderOpen] = useState(false)
  const [editItemsOpen, setEditItemsOpen] = useState(false)
  const [editItems, setEditItems] = useState<DraftItem[]>([makeEmptyItem()])
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('0')
  const [paymentDate, setPaymentDate] = useState(today)
  const [paymentNote, setPaymentNote] = useState('')
  const [paymentType, setPaymentType] = useState<'payment' | 'writeoff'>('payment')
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)

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
    queryKey: ['purchase-products', productSearch],
    queryFn: () => fetchProducts({ q: productSearch.trim() || undefined }),
  })

  const inventoryBatchesQ = useQuery<Item[], Error>({
    queryKey: ['purchase-existing-inventory', inventorySearch, existingInventoryFromDate],
    queryFn: () => listItems(inventorySearch.trim(), { include_archived: true, created_from: existingInventoryFromDate }),
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
    const shouldAdd = searchParams.get('new') === '1'
    if (supplierId > 0) {
      setPartyId(supplierId)
      setFilterPartyId(supplierId)
    }
    if (shouldAdd) setAddOpen(true)
    if (supplierId > 0 || shouldAdd) setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams])

  const createM = useMutation({
    mutationFn: createPurchase,
    onSuccess: () => {
      toast.push('Purchase saved', 'success')
      queryClient.invalidateQueries({ queryKey: ['purchases-list'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
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
      setPaymentOpen(false)
      setPaymentAmount('0')
      setPaymentNote('')
      setPaymentType('payment')
      setPaymentDate(today)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to save payment'), 'error'),
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

  const suppliers = suppliersQ.data || []
  const categories = categoriesQ.data || []
  const brandNames = (brandsQ.data || []).map((brand) => brand.name)
  const products = productsQ.data || []
  const inventoryBatches = inventoryBatchesQ.data || []
  const purchases = purchasesQ.data || []
  const selectedPurchase = selectedPurchaseQ.data || null
  const selectedSupplierName = selectedPurchase
    ? suppliers.find((s) => Number(s.id) === Number(selectedPurchase.party_id))?.name || `Supplier #${selectedPurchase.party_id}`
    : ''
  const supplierNameFor = (id: number) => suppliers.find((supplier) => Number(supplier.id) === Number(id))?.name || `Supplier #${id}`

  function resetForm() {
    setPartyId(null)
    setInvoiceNumber('')
    setInvoiceDate(today)
    setNotes('')
    setDiscountAmount('0')
    setRoundingAdjustment('0')
    setPaidAmount('0')
    setWriteoffAmount('0')
    setItems([makeEmptyItem()])
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
    else updateItem(itemKey, patch)
  }

  function applyExistingInventory(itemKey: string, inventoryItem: Item | null, editMode = false) {
    if (!inventoryItem) return
    const patch = {
      existing_inventory_item_id: inventoryItem.id,
      product_id: inventoryItem.product_id ?? undefined,
      product_name: inventoryItem.name,
      brand: inventoryItem.brand || '',
      category_id: inventoryItem.category_id ?? undefined,
      expiry_date: inventoryItem.expiry_date || '',
      rack_number: inventoryItem.rack_number || 0,
      sealed_qty: Number(inventoryItem.stock || 0) > 0 ? Number(inventoryItem.stock || 0) : 1,
      cost_price: Number(inventoryItem.cost_price || 0),
      mrp: Number(inventoryItem.mrp || 0),
      rounding_adjustment: 0,
    }
    if (editMode) updateEditItem(itemKey, patch)
    else updateItem(itemKey, patch)
  }

  function openDetail(purchaseId: number) {
    setSelectedPurchaseId(purchaseId)
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
    setEditItems(purchase.items.map((item) => ({
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
    })))
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
      toast.push('Every line needs a product name', 'error')
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
      items: cleanedItems.map(({ key, ...rest }) => rest),
      payments: [
        ...(Number(paidAmount || 0) > 0 ? [{ amount: Number(paidAmount), note: 'Initial payment', is_writeoff: false }] : []),
        ...(Number(writeoffAmount || 0) > 0 ? [{ amount: Number(writeoffAmount), note: 'Initial write-off', is_writeoff: true }] : []),
      ],
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
    if (!selectedPurchaseId) return
    addPaymentM.mutate({
      id: selectedPurchaseId,
      payload: {
        amount: Number(paymentAmount || 0),
        note: paymentNote.trim() || undefined,
        paid_at: paymentDate,
        is_writeoff: paymentType === 'writeoff',
      },
    })
  }

  function saveItemReplacement() {
    if (!selectedPurchaseId) return
    const cleanedItems = cleanItems(editItems)
    if (cleanedItems.some((item) => !item.product_name)) {
      toast.push('Every replacement line needs a product name', 'error')
      return
    }
    replaceItemsM.mutate({
      id: selectedPurchaseId,
      items: cleanedItems.map(({ key, ...rest }) => rest),
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
    const draftSubtotal = draftItems.reduce(
      (sum, item) => sum + lineBaseTotal(item),
      0,
    )
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
              {draftItems.length} line{draftItems.length === 1 ? '' : 's'} · Lines net {money(draftSubtotal)} · Free qty reduces average rate
            </Typography>
          </Box>
          <Stack direction="row" gap={1}>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setDraftItems((prev) => [...prev, makeEmptyItem()])}>Add Line</Button>
          </Stack>
        </Stack>

        <Stack divider={<Divider flexItem />} sx={{ p: 0 }}>
          {draftItems.map((item, index) => (
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
                        label={`Existing #${item.existing_inventory_item_id}`}
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
                    onClick={() => setDraftItems((prev) => (prev.length === 1 ? prev : prev.filter((row) => row.key !== item.key)))}
                  >
                    Remove
                  </Button>
                </Stack>
                <Grid container spacing={1.25} alignItems="center">
                  <Grid item xs={12} md={4}>
                    <Autocomplete
                      size="small"
                      options={inventoryBatches}
                      value={inventoryBatches.find((batch) => Number(batch.id) === Number(item.existing_inventory_item_id)) || null}
                      getOptionLabel={inventoryBatchLabel}
                      onInputChange={(_, value) => setInventorySearch(value)}
                      onChange={(_, value) => {
                        if (value) applyExistingInventory(item.key, value, editMode)
                        else patchItem(item.key, { existing_inventory_item_id: undefined })
                      }}
                      renderInput={(params) => <TextField {...params} label="Attach Existing Batch" fullWidth />}
                    />
                  </Grid>
                  <Grid item xs={12} md={3.5}>
                    <Autocomplete
                      size="small"
                      options={products}
                      getOptionLabel={(option) => `${option.name}${option.brand ? ` | ${option.brand}` : ''}`}
                      onInputChange={(_, value) => setProductSearch(value)}
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
                    <TextField size="small" label="Discount" type="number" value={item.discount_amount || 0} onChange={(e) => patchItem(item.key, { discount_amount: Number(e.target.value) })} fullWidth />
                  </Grid>
                  <Grid item xs={6} md={1.2}>
                    <TextField size="small" label="Round Off" type="number" value={item.rounding_adjustment || 0} onChange={(e) => patchItem(item.key, { rounding_adjustment: Number(e.target.value) })} fullWidth />
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
              </Stack>
            </Box>
          ))}
        </Stack>
      </Paper>
    )
  }

  return (
    <Stack gap={2}>
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((purchase) => (
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
                    <Button size="small" onClick={() => openDetail(Number(purchase.id))}>Open</Button>
                  </td>
                </tr>
              ))}
              {purchases.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Box p={2} color="text.secondary">No purchases found.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={1}>
            <Box>
              <Typography variant="h6">Add Purchase</Typography>
              <Typography variant="body2" color="text.secondary">
                {partyId ? supplierNameFor(partyId) : 'Select supplier'} | {invoiceDate || 'No date'}
              </Typography>
            </Box>
            <Chip label={`Total ${money(total)}`} color="primary" />
          </Stack>
        </DialogTitle>
        <DialogContent dividers>
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
                  <Typography variant="caption" color="text.secondary">Lines Net Total</Typography>
                  <Typography variant="h6">{money(subtotal)}</Typography>
                </Grid>
                <Grid item xs={12} md={3}>
                  <TextField label="Invoice Discount" type="number" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={3}>
                  <TextField label="Final Round Off" type="number" value={roundingAdjustment} onChange={(e) => setRoundingAdjustment(e.target.value)} fullWidth />
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
                      Average rate is recalculated line-wise as net line amount divided by total inward quantity including free units.
                    </Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField label="Initial Payment" type="number" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} fullWidth />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField label="Initial Write-off" type="number" value={writeoffAmount} onChange={(e) => setWriteoffAmount(e.target.value)} fullWidth />
                </Grid>
              </Grid>
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={submit} disabled={createM.isPending}>Save Purchase</Button>
        </DialogActions>
      </Dialog>

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

      <Dialog open={Boolean(selectedPurchaseId)} onClose={() => setSelectedPurchaseId(null)} fullWidth maxWidth="lg">
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
                  <Button variant="contained" startIcon={<PaymentsIcon />} onClick={() => setPaymentOpen(true)}>Add Payment</Button>
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
                      <th>Discount</th>
                      <th>Round Off</th>
                      <th>Line Total</th>
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
                      <th>Amount</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPurchase.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td>{fmtDateTime(payment.paid_at)}</td>
                        <td>{payment.is_writeoff ? 'Write-off' : 'Payment'}</td>
                        <td>{money(payment.amount)}</td>
                        <td>{payment.note || '-'}</td>
                      </tr>
                    ))}
                    {selectedPurchase.payments.length === 0 && (
                      <tr>
                        <td colSpan={4}>
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
          <Button variant="contained" onClick={saveHeaderEdit} disabled={updateM.isPending}>Save Changes</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={paymentOpen} onClose={() => setPaymentOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add Payment / Write-off</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <TextField select label="Entry Type" value={paymentType} onChange={(e) => setPaymentType(e.target.value as 'payment' | 'writeoff')} fullWidth>
              <MenuItem value="payment">Payment</MenuItem>
              <MenuItem value="writeoff">Write-off</MenuItem>
            </TextField>
            <TextField label="Amount" type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} fullWidth />
            <TextField label="Date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            <TextField label="Note" value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} multiline minRows={2} fullWidth />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPaymentOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={savePayment} disabled={addPaymentM.isPending}>Save</Button>
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
            {itemEditor(editItems, setEditItems, true)}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditItemsOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveItemReplacement} disabled={replaceItemsM.isPending}>Save Items</Button>
        </DialogActions>
      </Dialog>

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
