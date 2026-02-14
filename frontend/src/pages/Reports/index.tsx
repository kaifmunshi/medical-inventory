import { useEffect, useState, type ReactNode } from 'react'
import { Box, Button, Paper, Stack, TextField, Typography, MenuItem } from '@mui/material'

import SalesReport from './SalesReport'
import ReturnsReport from './ReturnsReport'
import StockLedgerReport from './StockLedgerReport'
import ItemSalesReport from './ItemSalesReport'
import { last15DaysRange } from '../../lib/date'

type Tab = 'sales' | 'returns' | 'stock' | 'item_sales'
type ViewMode = 'details' | 'aggregate'
type GroupBy = 'day' | 'month'
type DeletedFilter = 'active' | 'deleted' | 'all'

export default function Reports() {
  // ✅ default = last 15 days
  const { from: defaultFrom, to: defaultTo } = last15DaysRange()

  const [tab, setTab] = useState<Tab>('sales')
  const [viewMode, setViewMode] = useState<ViewMode>('details')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')
  const [deletedFilter, setDeletedFilter] = useState<DeletedFilter>('active')

  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)

  const [q, setQ] = useState('')

  // child-controlled extras + export
  const [extraControls, setExtraControls] = useState<ReactNode>(null)
  const [exportDisabled, setExportDisabled] = useState(true)
  const [exportFn, setExportFn] = useState<() => void>(() => () => {})

  // keep your old behavior: if not sales, force details
  useEffect(() => {
    if (tab !== 'sales' && viewMode === 'aggregate') setViewMode('details')
  }, [tab, viewMode])

  // if stock, force details (same as before)
  useEffect(() => {
    if (tab === 'stock') setViewMode('details')
  }, [tab])

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

            {tab === 'sales' && viewMode === 'details' && (
              <TextField
                select
                label="Bills"
                value={deletedFilter}
                onChange={(e) => setDeletedFilter(e.target.value as DeletedFilter)}
                sx={{ width: 180 }}
              >
                <MenuItem value="active">Active only</MenuItem>
                <MenuItem value="deleted">Deleted only</MenuItem>
                <MenuItem value="all">All (active + deleted)</MenuItem>
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
            deletedFilter={deletedFilter}
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
