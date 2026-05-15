import { useMemo, useState } from 'react'
import { Box, Button, Dialog, DialogTitle, DialogContent, Stack, TextField, Typography } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { listBillsPaged } from '../../services/billing'
// ✅ type-only import
import type { Bill } from '../../services/billing'
import { fetchFinancialYears } from '../../services/settings'
import type { FinancialYear } from '../../lib/types'
import { PRODUCT_SEARCH_MIN_CHARS } from '../../lib/constants'

// ✅ correct path to lib/date from components/billing/*
import { toYMD } from '../../lib/date'

function previousFinancialYear(years: FinancialYear[], activeYear: FinancialYear | null) {
  if (!activeYear) return null
  return (
    [...years]
      .filter((year) => year.end_date < activeYear.start_date)
      .sort((a, b) => b.start_date.localeCompare(a.start_date))[0] || null
  )
}

const BILL_PICKER_LIMIT = 20
const BILL_SEARCH_PROMPT = `Type ${PRODUCT_SEARCH_MIN_CHARS} letters, or a bill ID, to search`

export default function BillPickerDialog({
  open, onClose, onPick
}:{ open:boolean; onClose:()=>void; onPick:(bill:Bill)=>void }){

  // Server-side search over bill id, notes, item names, and brand.
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(toYMD(new Date()))
  const [to, setTo] = useState(toYMD(new Date()))
  const [offset, setOffset] = useState(0)
  const searchTerm = q.trim()
  const canSearchBills = /^\d+$/.test(searchTerm) || searchTerm.length >= PRODUCT_SEARCH_MIN_CHARS

  const { data, isFetching } = useQuery({
    queryKey:['bill-picker', searchTerm, from, to, offset],
    queryFn:async()=>{
      return listBillsPaged({
        q: searchTerm,
        from_date: from || undefined,
        to_date: to || undefined,
        limit: BILL_PICKER_LIMIT,
        offset,
      })
    },
    enabled: open && canSearchBills
  })
  const yearsQ = useQuery({
    queryKey: ['bill-picker-financial-years'],
    queryFn: fetchFinancialYears,
    enabled: open,
  })
  const activeYear = useMemo(() => (yearsQ.data || []).find((year) => year.is_active) || null, [yearsQ.data])
  const prevYear = useMemo(() => previousFinancialYear(yearsQ.data || [], activeYear), [activeYear, yearsQ.data])

  // Raw rows from API
  const rows = useMemo(()=> (canSearchBills ? (data?.items || []) : []) as Bill[], [canSearchBills, data])
  const hasNextPage = Boolean(data?.next_offset)

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Find Bill</DialogTitle>
      <DialogContent>
        <Stack direction={{xs:'column', md:'row'}} gap={2} sx={{ mb:2 }}>
          <TextField
            label="Search (bill ID / item / brand / notes)"
            value={q}
            onChange={e=>{
              setOffset(0)
              setQ(e.target.value)
            }}
            helperText={BILL_SEARCH_PROMPT}
            fullWidth
          />
          <TextField
            label="From"
            type="date"
            value={from}
            onChange={e=>{ setOffset(0); setFrom(e.target.value) }}
            InputLabelProps={{shrink:true}}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            onChange={e=>{ setOffset(0); setTo(e.target.value) }}
            InputLabelProps={{shrink:true}}
          />
          <Button
            variant="contained"
            onClick={()=>setOffset(0)}
            disabled={!canSearchBills || isFetching}
          >
            Search
          </Button>
        </Stack>

        <Stack direction={{xs:'column', md:'row'}} gap={1} sx={{ mb:2 }}>
          {activeYear ? (
            <Button
              variant="outlined"
              onClick={() => {
                setOffset(0)
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
                setOffset(0)
                setFrom(prevYear.start_date)
                setTo(prevYear.end_date)
              }}
            >
              Previous FY
            </Button>
          ) : null}
          <Button
            variant="outlined"
            onClick={() => {
              setOffset(0)
              setFrom('')
              setTo('')
            }}
          >
            All Bills
          </Button>
        </Stack>

        <Box sx={{ overflowX:'auto', maxHeight:'60vh' }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th><th>Date/Time</th><th>Items</th><th>Total</th><th>Mode</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b)=>(
                <tr key={b.id}>
                  <td>{b.id}</td>
                  <td>{b.date_time}</td>
                  <td>{(b.items || []).length}</td>
                  <td>
                    {(
                      typeof b.total_amount === 'number'
                        ? b.total_amount
                        : (b.items || []).reduce((s, it) => s + Number(it.line_total ?? (it.mrp*it.quantity)), 0)
                    ).toFixed(2)}
                  </td>
                  <td>{b.payment_mode || ''}</td>
                  <td><Button size="small" onClick={()=>{ onPick(b); onClose() }}>Select</Button></td>
                </tr>
              ))}
              {rows.length===0 && (
                <tr>
                  <td colSpan={6}>
                    <Box p={2}>
                      <Typography color="text.secondary">
                        {!canSearchBills ? BILL_SEARCH_PROMPT : isFetching ? 'Searching bills...' : 'No bills found.'}
                      </Typography>
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>

        <Stack direction="row" justifyContent="space-between" sx={{ mt:1 }}>
          <Button onClick={()=>setOffset((prev)=>Math.max(0, prev - BILL_PICKER_LIMIT))} disabled={offset===0 || isFetching}>Prev</Button>
          <Button onClick={()=>setOffset(data?.next_offset ?? offset + BILL_PICKER_LIMIT)} disabled={!hasNextPage || isFetching}>Next</Button>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
