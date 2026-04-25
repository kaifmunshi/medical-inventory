import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Box, Button, Paper, Stack, TextField, Typography, MenuItem } from '@mui/material'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import SalesReport from './SalesReport'
import ReturnsReport from './ReturnsReport'
import StockLedgerReport from './StockLedgerReport'
import ItemSalesReport from './ItemSalesReport'
import { last15DaysRange } from '../../lib/date'
import { fetchFinancialYears } from '../../services/settings'
import type { FinancialYear } from '../../lib/types'

type Tab = 'sales' | 'returns' | 'stock' | 'item_sales'
type ViewMode = 'details' | 'aggregate'
type GroupBy = 'day' | 'month'

function previousFinancialYear(years: FinancialYear[], activeYear: FinancialYear | null) {
  if (!activeYear) return null
  return (
    [...years]
      .filter((year) => year.end_date < activeYear.start_date)
      .sort((a, b) => b.start_date.localeCompare(a.start_date))[0] || null
  )
}

export default function Reports() {
  // ✅ default = last 15 days
  const { from: defaultFrom, to: defaultTo } = last15DaysRange()
  const [searchParams] = useSearchParams()

  const [tab, setTab] = useState<Tab>('sales')
  const [viewMode, setViewMode] = useState<ViewMode>('details')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')

  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)

  const [q, setQ] = useState('')

  // child-controlled extras + export
  const [extraControls, setExtraControls] = useState<ReactNode>(null)
  const [exportDisabled, setExportDisabled] = useState(true)
  const [exportFn, setExportFn] = useState<() => void>(() => () => {})
  const yearsQ = useQuery({
    queryKey: ['reports-financial-years'],
    queryFn: fetchFinancialYears,
  })
  const activeYear = useMemo(() => (yearsQ.data || []).find((year) => year.is_active) || null, [yearsQ.data])
  const prevYear = useMemo(() => previousFinancialYear(yearsQ.data || [], activeYear), [activeYear, yearsQ.data])

  const incomingState = useMemo<{
    tab: Tab
    viewMode: ViewMode
    groupBy: GroupBy
    from: string
    to: string
    q: string
    billId: number | null
    stockName: string
    stockBrand: string
    stockView: string
    stockReason: string
    openReconcile: boolean
  }>(() => {
    const incomingTab = searchParams.get('tab')
    const incomingView = searchParams.get('view')
    const incomingGroupBy = searchParams.get('group_by')

    return {
      tab:
        incomingTab === 'sales' || incomingTab === 'returns' || incomingTab === 'stock' || incomingTab === 'item_sales'
          ? incomingTab
          : 'sales',
      viewMode: incomingView === 'aggregate' ? 'aggregate' : 'details',
      groupBy: incomingGroupBy === 'month' ? 'month' : 'day',
      from: searchParams.has('from') ? searchParams.get('from') || '' : defaultFrom,
      to: searchParams.has('to') ? searchParams.get('to') || '' : defaultTo,
      q: searchParams.get('q') || '',
      billId: Number(searchParams.get('bill_id') || 0) || null,
      stockName: (searchParams.get('stock_name') || '').trim(),
      stockBrand: (searchParams.get('stock_brand') || '').trim(),
      stockView: (searchParams.get('stock_view') || '').trim(),
      stockReason: (searchParams.get('stock_reason') || '').trim(),
      openReconcile: searchParams.get('open_reconcile') === '1',
    }
  }, [defaultFrom, defaultTo, searchParams])

  useEffect(() => {
    setTab(incomingState.tab)
    setViewMode(incomingState.viewMode)
    setGroupBy(incomingState.groupBy)
    setFrom(incomingState.from)
    setTo(incomingState.to)
    setQ(incomingState.q)
  }, [
    incomingState.from,
    incomingState.groupBy,
    incomingState.q,
    incomingState.tab,
    incomingState.to,
    incomingState.viewMode,
  ])

  // keep your old behavior: if not sales, force details
  useEffect(() => {
    if (tab !== 'sales' && viewMode === 'aggregate') setViewMode('details')
  }, [tab, viewMode])

  // if stock, force details (same as before)
  useEffect(() => {
    if (tab === 'stock') setViewMode('details')
  }, [tab])

  useEffect(() => {
    if (tab !== 'stock') setExtraControls(null)
  }, [tab, setExtraControls])

  return (
    <Stack gap={2}>
      <Typography variant="h5">Reports</Typography>

      {/* Top Filters */}
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
              sx={{ width: 200 }}
            >
              <MenuItem value="sales">Sales</MenuItem>
              <MenuItem value="returns">Returns</MenuItem>
              <MenuItem value="stock">Stock Ledger</MenuItem> 
              <MenuItem value="item_sales">Item Sales</MenuItem>
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

            {activeYear ? (
              <Button
                variant="outlined"
                onClick={() => {
                  setFrom(activeYear.start_date)
                  setTo(activeYear.end_date)
                }}
              >
                Current FY
              </Button>
            ) : null}

            {prevYear ? (
              <Button
                variant="outlined"
                onClick={() => {
                  setFrom(prevYear.start_date)
                  setTo(prevYear.end_date)
                }}
              >
                Previous FY
              </Button>
            ) : null}

            {tab === 'sales' && viewMode === 'details' && (
              <TextField
                label="Search (id/item/notes)"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            )}

            {tab === 'item_sales' && (
              <TextField
                label="Search (name/brand)"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            )}

            {/* Stock-only extra controls live here, injected by StockLedgerReport */}
            {tab === 'stock' ? extraControls : null}
          </Stack>

          <Button variant="outlined" onClick={() => exportFn()} disabled={exportDisabled}>
            Export CSV
          </Button>
        </Stack>

        {/* Optional extra info area injected by children */}
        {tab === 'stock' ? <Box mt={1}>{/* stock component can render its info in content */}</Box> : null}
      </Paper>

      {/* Content */}
      <Paper sx={{ p: 2 }}>
        {tab === 'sales' ? (
          <SalesReport
            from={from}
            to={to}
            q={q}
            viewMode={viewMode}
            groupBy={groupBy}
            deletedFilter="active"
            focusBillId={incomingState.billId}
            setExportFn={setExportFn}
            setExportDisabled={setExportDisabled}
          />
        ) : tab === 'returns' ? (
          <ReturnsReport
            from={from}
            to={to}
            setExportFn={setExportFn}
            setExportDisabled={setExportDisabled}
          />
        ) : tab === 'stock' ? (
          <StockLedgerReport
            from={from}
            to={to}
            initialSearch={incomingState.q}
            initialReason={incomingState.stockReason}
            focusName={incomingState.stockName}
            focusBrand={incomingState.stockBrand}
            autoOpenLedger={incomingState.stockView === 'ledger'}
            autoOpenReconcile={incomingState.openReconcile}
            setExportFn={setExportFn}
            setExportDisabled={setExportDisabled}
            setExtraControls={setExtraControls}
          />
        ) : (
          <ItemSalesReport
            from={from}
            to={to}
            q={q}
            setExportFn={setExportFn}
            setExportDisabled={setExportDisabled}
          />
        )}
      </Paper>
    </Stack>
  )
}
