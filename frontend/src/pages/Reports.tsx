// F:\medical-inventory\frontend\src\pages\Reports.tsx
import { useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Dialog, DialogTitle, DialogContent, Divider,
  IconButton, Link, MenuItem, Paper, Stack, TextField, Tooltip, Typography
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useQuery } from '@tanstack/react-query';
import { listBills, getBill } from '../services/billing';
import { listReturns, getReturn } from '../services/returns';
import { toYMD, todayRange } from '../lib/date';

type Tab = 'sales' | 'returns';

function toCSV(rows: string[][]) {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',')
    )
    .join('\n');
}

function itemsPreview(items: any[], max = 6) {
  const names = (items || []).map(
    (it: any) => it.item_name || it.name || it.item?.name || `#${it.item_id}`
  );
  if (names.length <= max) return names.join(', ') || '—';
  const head = names.slice(0, max).join(', ');
  return `${head} +${names.length - max} more`;
}

function money(n: number | string | undefined | null) {
  const v = Number(n || 0);
  return v.toFixed(2);
}

export default function Reports() {
  const { from: todayFrom, to: todayTo } = todayRange();
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState(todayFrom);
  const [to, setTo] = useState(todayTo);
  const [q, setQ] = useState('');

  // Detail dialog state
  const [open, setOpen] = useState(false);
  const [detailType, setDetailType] = useState<'bill' | 'return' | null>(null);
  const [detail, setDetail] = useState<any | null>(null); // bill or return object

  const qSales = useQuery({
    queryKey: ['rpt-sales', from, to, q],
    queryFn: () => listBills({ from_date: from, to_date: to, q, limit: 500 }),
    enabled: tab === 'sales',
  });

  const qRets = useQuery({
    queryKey: ['rpt-returns', from, to],
    queryFn: () => listReturns({ from_date: from, to_date: to, limit: 500 }),
    enabled: tab === 'returns',
  });

  const rows = useMemo(() => {
    if (tab === 'sales') {
      const bills = (qSales.data || []) as any[];
      return bills.map((b) => {
        // Compute line-based figures for display (subtotal/discount/tax)
        const sub = (b.items || []).reduce(
          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
          0
        );
        const disc = sub * Number(b.discount_percent || 0) / 100;
        const afterDisc = sub - disc;
        const tax = afterDisc * Number(b.tax_percent || 0) / 100;

        // ✅ TOTAL: use saved final total_amount as source of truth (fallback to computed if absent)
        const totalAmount =
          b.total_amount !== undefined && b.total_amount !== null
            ? Number(b.total_amount)
            : afterDisc + tax;

        return {
          raw: b, // keep original for dialog
          id: b.id,
          date: b.date_time || b.created_at || '',
          itemsCount: (b.items || []).length,
          itemsPreview: itemsPreview(b.items || []),
          subtotal: money(sub),
          discount: money(disc),
          tax: money(tax),
          total: money(totalAmount), // ⬅️ uses total_amount
          mode: b.payment_mode || '',
        };
      });
    } else {
      const rets = (qRets.data || []) as any[];
      return rets.map((r) => {
        const refundCalc = (r.items || []).reduce(
          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
          0
        );
        const refund = r.subtotal_return ?? refundCalc;
        return {
          raw: r,
          id: r.id,
          date: r.date_time || r.created_at || '',
          linesCount: (r.items || []).length,
          itemsPreview: itemsPreview(r.items || []),
          refund: money(refund),
          notes: r.notes || '',
        };
      });
    }
  }, [tab, qSales.data, qRets.data]);

  async function openDetail(row: any) {
    if (tab === 'sales') {
      let b = row.raw;
      // If items missing, fetch full bill
      if (!b?.items || !Array.isArray(b.items) || b.items.length === 0) {
        try {
          b = await getBill(row.id);
        } catch {}
      }
      setDetailType('bill');
      setDetail(b);
      setOpen(true);
    } else {
      let r = row.raw;
      if (!r?.items || !Array.isArray(r.items) || r.items.length === 0) {
        try {
          r = await getReturn(row.id);
        } catch {}
      }
      setDetailType('return');
      setDetail(r);
      setOpen(true);
    }
  }

  function downloadCSV() {
    const header =
      tab === 'sales'
        ? ['Bill ID', 'Date/Time', 'Items', 'Subtotal', 'Discount', 'Tax', 'Total', 'Payment Mode']
        : ['Return ID', 'Date/Time', 'Lines', 'Refund', 'Notes'];

    const body = (rows as any[]).map((r: any) =>
      tab === 'sales'
        ? [r.id, r.date, r.itemsCount, r.subtotal, r.discount, r.tax, r.total, r.mode] // r.total already from total_amount
        : [r.id, r.date, r.linesCount, r.refund, r.notes]
    );

    const csv = toCSV([header, ...body]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tab}-report_${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Stack gap={2}>
        <Typography variant="h5">Reports</Typography>

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
                sx={{ width: 160 }}
              >
                <MenuItem value="sales">Sales</MenuItem>
                <MenuItem value="returns">Returns</MenuItem>
              </TextField>
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
              {tab === 'sales' && (
                <TextField
                  label="Search (id/item/notes)"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              )}
            </Stack>
            <Button
              variant="outlined"
              onClick={downloadCSV}
              disabled={(rows as any[]).length === 0}
            >
              Export CSV
            </Button>
          </Stack>
        </Paper>

        <Paper sx={{ p: 2 }}>
          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                {tab === 'sales' ? (
                  <tr>
                    <th>Bill ID</th>
                    <th>Date/Time</th>
                    <th>Items</th>
                    <th>Subtotal</th>
                    <th>Discount</th>
                    <th>Tax</th>
                    <th>Total</th>
                    <th>Mode</th>
                  </tr>
                ) : (
                  <tr>
                    <th>Return ID</th>
                    <th>Date/Time</th>
                    <th>Lines</th>
                    <th>Refund</th>
                    <th>Notes</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {(rows as any[]).map((r: any) =>
                  tab === 'sales' ? (
                    <tr key={`b-${r.id}`}>
                      <td>
                        <Tooltip title={r.itemsPreview} arrow placement="top">
                          <Link
                            component="button"
                            onClick={() => openDetail(r)}
                            underline="hover"
                          >
                            {r.id}
                          </Link>
                        </Tooltip>
                      </td>
                      <td>{r.date}</td>
                      <td>{r.itemsCount}</td>
                      <td>{r.subtotal}</td>
                      <td>{r.discount}</td>
                      <td>{r.tax}</td>
                      <td>{r.total}</td> {/* uses total_amount */}
                      <td>{r.mode}</td>
                    </tr>
                  ) : (
                    <tr key={`r-${r.id}`}>
                      <td>
                        <Tooltip title={r.itemsPreview} arrow placement="top">
                          <Link
                            component="button"
                            onClick={() => openDetail(r)}
                            underline="hover"
                          >
                            {r.id}
                          </Link>
                        </Tooltip>
                      </td>
                      <td>{r.date}</td>
                      <td>{r.linesCount}</td>
                      <td>{r.refund}</td>
                      <td>{r.notes}</td>
                    </tr>
                  )
                )}
                {(rows as any[]).length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <Box p={2} color="text.secondary">
                        No data.
                      </Box>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>
        </Paper>
      </Stack>

      {/* Detail dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {detailType === 'bill' ? 'Bill Details' : 'Return Details'}
          <IconButton onClick={() => setOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {!detail ? (
            <Typography color="text.secondary">Loading…</Typography>
          ) : (
            <Stack gap={2}>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                justifyContent="space-between"
                gap={1}
              >
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
                      const name =
                        it.item_name || it.name || it.item?.name || `#${it.item_id}`;
                      const qty = Number(it.quantity);
                      const mrp = Number(it.mrp);
                      return (
                        <tr key={idx}>
                          <td>{name}</td>
                          <td>{qty}</td>
                          <td>{money(mrp)}</td>
                          <td>{money(qty * mrp)}</td>
                        </tr>
                      );
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

              {detailType === 'bill' ? (
                <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 360 }}>
                  {/* Keep showing computed parts for transparency */}
                  <Typography>
                    Subtotal:{' '}
                    <b>
                      {money(
                        (detail.items || []).reduce(
                          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
                          0
                        )
                      )}
                    </b>
                  </Typography>
                  <Typography>
                    Discount ({Number(detail.discount_percent || 0)}%):{' '}
                    <b>
                      {money(
                        ((detail.items || []).reduce(
                          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
                          0
                        ) *
                          Number(detail.discount_percent || 0)) /
                          100
                      )}
                    </b>
                  </Typography>
                  <Typography>
                    Tax ({Number(detail.tax_percent || 0)}%):{' '}
                    <b>
                      {(() => {
                        const sub = (detail.items || []).reduce(
                          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
                          0
                        );
                        const disc = (sub * Number(detail.discount_percent || 0)) / 100;
                        const afterDisc = sub - disc;
                        return money((afterDisc * Number(detail.tax_percent || 0)) / 100);
                      })()}
                    </b>
                  </Typography>

                  {/* ✅ TOTAL: show saved final total_amount (fallback to computed if absent) */}
                  <Typography>
                    Total:{' '}
                    <b>
                      {(() => {
                        const sub = (detail.items || []).reduce(
                          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
                          0
                        );
                        const disc = (sub * Number(detail.discount_percent || 0)) / 100;
                        const afterDisc = sub - disc;
                        const tax = (afterDisc * Number(detail.tax_percent || 0)) / 100;
                        const computed = afterDisc + tax;
                        const final = detail.total_amount !== undefined && detail.total_amount !== null
                          ? Number(detail.total_amount)
                          : computed;
                        return money(final);
                      })()}
                    </b>
                  </Typography>

                  <Typography>
                    Payment Mode: <b>{detail.payment_mode || '-'}</b>
                  </Typography>
                  {(detail.payment_mode === 'split' ||
                    detail.payment_cash ||
                    detail.payment_online) && (
                    <Typography color="text.secondary">
                      Cash {money(detail.payment_cash)} | Online {money(detail.payment_online)}
                    </Typography>
                  )}
                  {detail.notes ? (
                    <Typography sx={{ mt: 1 }}>
                      Notes: <i>{detail.notes}</i>
                    </Typography>
                  ) : null}
                </Stack>
              ) : (
                <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 360 }}>
                  <Typography>
                    Refund:{' '}
                    <b>
                      {money(
                        detail.subtotal_return ??
                          (detail.items || []).reduce(
                            (s: number, it: any) =>
                              s + Number(it.mrp) * Number(it.quantity),
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
              )}
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
