import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Dialog, DialogTitle, DialogContent, Stack, TextField } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
// ✅ value import
import { listBills } from '../../services/billing'
// ✅ type-only import
import type { Bill } from '../../services/billing'

// ✅ correct path to lib/date from components/billing/*
import { toYMD } from '../../lib/date'

export default function BillPickerDialog({
  open, onClose, onPick
}:{ open:boolean; onClose:()=>void; onPick:(bill:Bill)=>void }){

  // Client-side search over id/notes/item names
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(toYMD(new Date()))
  const [to, setTo] = useState(toYMD(new Date()))
  const [offset, setOffset] = useState(0)

  const { data, refetch, isFetching } = useQuery({
    queryKey:['bill-picker', from, to, offset],
    queryFn:()=>listBills({ from_date: from, to_date: to, limit: 20, offset }),
    enabled: open
  })

  useEffect(()=>{ if(open) refetch() }, [open])

  // Raw rows from API
  const rows = useMemo(()=> (data || []) as Bill[], [data])

  // Client filter: id, notes, any item_name
  const filtered = useMemo(()=>{
    const t = q.trim().toLowerCase()
    if (!t) return rows
    return rows.filter(b => {
      if (String(b.id).includes(t)) return true
      if (b.notes && b.notes.toLowerCase().includes(t)) return true
      return (b.items || []).some(it => (it.item_name || '').toLowerCase().includes(t))
    })
  }, [rows, q])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Find Bill</DialogTitle>
      <DialogContent>
        <Stack direction={{xs:'column', md:'row'}} gap={2} sx={{ mb:2 }}>
          <TextField
            label="Search (id / item / notes)"
            value={q}
            onChange={e=>setQ(e.target.value)}
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
            onClick={()=>{ setOffset(0); refetch() }}
            disabled={isFetching}
          >
            Search
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
              {filtered.map((b)=>(
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
              {filtered.length===0 && (
                <tr><td colSpan={6}><Box p={2}>No bills.</Box></td></tr>
              )}
            </tbody>
          </table>
        </Box>

        <Stack direction="row" justifyContent="space-between" sx={{ mt:1 }}>
          <Button onClick={()=>{ const n=Math.max(0, offset-20); setOffset(n); refetch() }} disabled={offset===0}>Prev</Button>
          <Button onClick={()=>{ setOffset(offset+20); refetch() }}>Next</Button>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
