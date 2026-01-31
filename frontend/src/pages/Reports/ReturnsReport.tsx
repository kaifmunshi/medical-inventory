import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  Divider,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useInfiniteQuery } from '@tanstack/react-query'

import { listReturns, getReturn } from '../../services/returns'

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

export default function ReturnsReport(props: {
  from: string
  to: string
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
}) {
  const { from, to, setExportFn, setExportDisabled } = props

  // dialog
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<any | null>(null)

  const qRets = useInfiniteQuery({
    queryKey: ['rpt-returns', from, to],
    enabled: true,
    initialPageParam: 0,
    queryFn: async () => {
      return await listReturns({ from_date: from, to_date: to, limit: 500 })
    },
    getNextPageParam: () => undefined,
  })

  const returnsRaw = useMemo(() => {
    const pages: any[] = ((qRets.data as any)?.pages ?? []) as any[]
    const all: any[] = []
    for (const p of pages) if (Array.isArray(p)) all.push(...p)
    return all
  }, [qRets.data])

  const detailRows = useMemo(() => {
    const rets = (returnsRaw || []) as any[]
    return rets.map((r) => {
      const refundCalc = (r.items || []).reduce(
        (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
        0
      )
      const refund = r.subtotal_return ?? refundCalc
      return {
        raw: r,
        id: r.id,
        date: r.date_time || r.created_at || '',
        linesCount: (r.items || []).length,
        itemsPreview: itemsPreview(r.items || []),
        refund: money(refund),
        notes: r.notes || '',
      }
    })
  }, [returnsRaw])

  async function openDetail(row: any) {
    let r = row.raw
    if (!r?.items || !Array.isArray(r.items) || r.items.length === 0) {
      try {
        r = await getReturn(row.id)
      } catch {}
    }
    setDetail(r)
    setOpen(true)
  }

  // export
  useEffect(() => {
    setExportDisabled(detailRows.length === 0)
    setExportFn(() => () => {
      const header = ['Return ID', 'Date/Time', 'Lines', 'Refund', 'Notes']
      const body = detailRows.map((r: any) => [r.id, r.date, r.linesCount, r.refund, r.notes])

      const csv = toCSV([header, ...body])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `returns-report_${from}_to_${to}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
  }, [setExportDisabled, setExportFn, detailRows, from, to])

  return (
    <>
      <Box sx={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Return ID</th>
              <th>Date/Time</th>
              <th>Lines</th>
              <th>Refund</th>
              <th>Notes</th>
            </tr>
          </thead>

          <tbody>
            {detailRows.map((r: any) => (
              <tr key={`r-${r.id}`}>
                <td>
                  <Tooltip title={r.itemsPreview} arrow placement="top">
                    <Link component="button" onClick={() => openDetail(r)} underline="hover">
                      {r.id}
                    </Link>
                  </Tooltip>
                </td>
                <td>{r.date}</td>
                <td>{r.linesCount}</td>
                <td>{r.refund}</td>
                <td>{r.notes}</td>
              </tr>
            ))}

            {detailRows.length === 0 && !qRets.isLoading && (
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

      {qRets.isLoading && (
        <Box sx={{ py: 2, textAlign: 'center' }}>
          <Typography variant="body2">Loading…</Typography>
        </Box>
      )}

      {qRets.isError && (
        <Box sx={{ py: 2, textAlign: 'center' }}>
          <Typography variant="body2" color="error">
            Failed to load.
          </Typography>
        </Box>
      )}

      {/* Return detail dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Return Details
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
                          <td>{money(qty * mrp)}</td>
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

              <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 360 }}>
                <Typography>
                  Refund:{' '}
                  <b>
                    {money(
                      detail.subtotal_return ??
                        (detail.items || []).reduce(
                          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
                          0
                        )
                    )}
                  </b>
                </Typography>
                {detail.notes ? (
                  <Typography sx={{ mt: 1 }}>
                    Notes: <i>{detail.notes}</i>
                  </Typography>
                ) : null}
              </Stack>
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
