type DeletedFilter = 'active' | 'deleted' | 'all'

type SalesReportLinkParams = {
  billId?: number | null
  q?: string
  from?: string
  to?: string
  deletedFilter?: DeletedFilter
}

type StockReportLinkParams = {
  q?: string
  name?: string
  brand?: string | null
  from?: string
  to?: string
  reason?: string
  openLedger?: boolean
  openReconcile?: boolean
}

function cleanValue(value?: string | number | null) {
  return value == null ? '' : String(value).trim()
}

export function buildSalesReportLink(params: SalesReportLinkParams = {}) {
  const query = new URLSearchParams()
  query.set('tab', 'sales')
  query.set('view', 'details')

  const billId = Number(params.billId || 0) || null
  const q = billId ? String(billId) : cleanValue(params.q)

  if (q) query.set('q', q)
  if (billId) query.set('bill_id', String(billId))
  if (params.deletedFilter) query.set('deleted_filter', params.deletedFilter)
  if (params.from !== undefined) query.set('from', params.from)
  if (params.to !== undefined) query.set('to', params.to)

  return `/reports?${query.toString()}`
}

export function buildStockReportLink(params: StockReportLinkParams = {}) {
  const query = new URLSearchParams()
  query.set('tab', 'stock')

  const q = cleanValue(params.q || params.name)
  const name = cleanValue(params.name)
  const brand = cleanValue(params.brand)
  const reason = cleanValue(params.reason)

  if (q) query.set('q', q)
  if (name) query.set('stock_name', name)
  if (brand) query.set('stock_brand', brand)
  if (reason) query.set('stock_reason', reason)
  if (params.from !== undefined) query.set('from', params.from)
  if (params.to !== undefined) query.set('to', params.to)
  if (params.openLedger) query.set('stock_view', 'ledger')
  if (params.openReconcile) query.set('open_reconcile', '1')

  return `/reports?${query.toString()}`
}
