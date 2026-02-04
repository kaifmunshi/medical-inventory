import { useEffect, useMemo } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import { useInfiniteQuery } from '@tanstack/react-query'
import { getItemSalesReport, type ItemSalesRow } from '../../services/billing'

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

function downloadCSV(filename: string, rows: string[][]) {
  const csv = toCSV(rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ✅ NEW: remove hidden/control characters and trim
function cleanText(v: any) {
  const s = String(v ?? '')
  // remove ASCII control chars + DEL, plus common zero-width chars
  const cleaned = s
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
  return cleaned
}

export default function ItemSalesReport(props: {
  from: string
  to: string
  q: string
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
}) {
  const LIMIT = 60

  const qItems = useInfiniteQuery({
    queryKey: ['report-item-sales', props.from, props.to, props.q, LIMIT],
    enabled: !!props.from && !!props.to,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      return await getItemSalesReport({
        from_date: props.from,
        to_date: props.to,
        q: props.q?.trim() ? props.q.trim() : undefined,
        limit: LIMIT,
        offset: pageParam,
      })
    },
    getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
  })

  const rows: ItemSalesRow[] = useMemo(() => {
    const pages = (qItems.data as any)?.pages ?? []
    const out: ItemSalesRow[] = []
    for (const p of pages) {
      if (p && Array.isArray(p.items)) out.push(...p.items)
    }
    return out
  }, [qItems.data])

  useEffect(() => {
    props.setExportDisabled(rows.length === 0)

    props.setExportFn(() => () => {
      const header = ['Item ID', 'Item Name', 'Brand', 'Qty Sold', 'Gross Sales', 'Last Sold At']
      const body = rows.map((r) => [
        String(r.item_id ?? ''),
        cleanText(r.item_name ?? ''),
        cleanText(r.brand ?? ''),
        String(r.qty_sold ?? 0),
        String(r.gross_sales ?? 0),
        String(r.last_sold_at ?? ''),
      ])

      downloadCSV(`item-sales_${props.from}_to_${props.to}.csv`, [header, ...body])
    })
  }, [rows, props.from, props.to, props.setExportDisabled, props.setExportFn])

  return (
    <Stack gap={1.5}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        gap={1}
        alignItems={{ sm: 'center' }}
        justifyContent="space-between"
      >
        <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
          <Chip label={`Rows: ${rows.length}`} sx={{ fontWeight: 800 }} variant="outlined" />
          <Chip label={`Range: ${props.from} → ${props.to}`} sx={{ fontWeight: 700 }} variant="outlined" />
          {props.q?.trim() ? <Chip label={`Filter: ${props.q.trim()}`} sx={{ fontWeight: 700 }} /> : null}
        </Stack>

        <Typography variant="body2" color="text.secondary">
          Sorted by Qty Sold (highest first)
        </Typography>
      </Stack>

      <Box sx={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>ID</th>
              <th>Item</th>
              <th style={{ width: 180 }}>Brand</th>
              <th style={{ width: 120 }}>Qty Sold</th>
              <th style={{ width: 140 }}>Gross</th>
              <th style={{ width: 200 }}>Last Sold</th>
            </tr>
          </thead>

          <tbody>
            {qItems.isLoading && (
              <tr>
                <td colSpan={6}>
                  <Box p={2} color="text.secondary">
                    Loading…
                  </Box>
                </td>
              </tr>
            )}

            {!qItems.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <Box p={2} color="text.secondary">
                    No sales found for this date range.
                  </Box>
                </td>
              </tr>
            )}

            {rows.map((r, idx) => {
              const brand = cleanText(r.brand)
              return (
                <tr key={`${r.item_id}-${idx}`}>
                  <td>{r.item_id}</td>
                  <td style={{ fontWeight: 700 }}>{cleanText(r.item_name)}</td>
                  <td>{brand ? brand : '—'}</td>
                  <td style={{ fontWeight: 800 }}>{r.qty_sold}</td>
                  <td>{Number(r.gross_sales || 0).toFixed(2)}</td>
                  <td>{r.last_sold_at || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Box>

      {qItems.isError && (
        <Box sx={{ py: 1 }}>
          <Typography variant="body2" color="error">
            Failed to load item sales.
          </Typography>
        </Box>
      )}

      <Stack direction="row" justifyContent="flex-end">
        <button
          className="btn"
          onClick={() => qItems.fetchNextPage()}
          disabled={!qItems.hasNextPage || qItems.isFetchingNextPage}
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid rgba(0,0,0,0.12)',
            background: qItems.hasNextPage ? 'white' : '#f5f5f5',
            cursor: qItems.hasNextPage ? 'pointer' : 'not-allowed',
            fontWeight: 700,
          }}
        >
          {qItems.isFetchingNextPage ? 'Loading…' : qItems.hasNextPage ? 'Load more' : 'No more'}
        </button>
      </Stack>
    </Stack>
  )
}
