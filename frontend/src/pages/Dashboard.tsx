// F:\medical-inventory\frontend\src\pages\Dashboard.tsx
import { useMemo, useState, useEffect } from 'react';
import {
  Grid,
  Paper,
  Typography,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Tooltip,
  Button,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { listBills } from '../services/billing';
import { listReturns } from '../services/returns';
import { listItems } from '../services/inventory';
import { todayRange } from '../lib/date';

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}`
}

const LOW_STOCK_THRESH = 2;       // ≤ 2 is low-stock
const EXPIRY_WINDOW_DAYS = 60;    // within next 60 days

export default function Dashboard() {
  const { from, to } = todayRange();

  const [openLow, setOpenLow] = useState(false);
  const [openExp, setOpenExp] = useState(false);

  // --- shortcut state: controls Today’s Sales + Returns cards ---
  const [showMoneyCards, setShowMoneyCards] = useState(false);

  // breakdown dialog for Today’s Sales
  const [openSalesBreakdown, setOpenSalesBreakdown] = useState(false);

  // Ctrl + Shift + S => toggle financial cards
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setShowMoneyCards((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const qBills = useQuery({
    queryKey: ['dash-bills', from, to],
    queryFn: () => listBills({ from_date: from, to_date: to, limit: 500 }),
  });

  const qReturns = useQuery({
    queryKey: ['dash-returns', from, to],
    queryFn: () => listReturns({ from_date: from, to_date: to, limit: 500 }),
  });

  const qInv = useQuery({
    queryKey: ['dash-inventory'],
    queryFn: () => listItems(''), // fetch all
  });

  // ---- Today’s Sales + payment-mode breakdown ----
  const { salesToday, cashSalesToday, onlineSalesToday } = useMemo(() => {
    const bills = (qBills.data || []) as any[];

    let total = 0;
    let cash = 0;
    let online = 0;

    for (const b of bills) {
      total += Number(b.total_amount || 0);
      cash += Number(b.payment_cash || 0);
      online += Number(b.payment_online || 0);
    }

    return {
      salesToday: total,
      cashSalesToday: cash,
      onlineSalesToday: online,
    };
  }, [qBills.data]);

  // ---- Returns ----
  const todayRefunds = useMemo(() => {
    const rets = (qReturns.data || []) as any[];
    let total = 0;
    for (const r of rets) {
      if (typeof r.subtotal_return === 'number') total += r.subtotal_return;
      else
        total += (r.items || []).reduce(
          (s: number, it: any) => s + Number(it.mrp) * Number(it.quantity),
          0
        );
    }
    return Math.round(total * 100) / 100;
  }, [qReturns.data]);

  // ---- Gross Cash (Total - Returns - Online) ----
  const grossCashToday = useMemo(() => {
    const val =
      Number(salesToday || 0) - Number(todayRefunds || 0) - Number(onlineSalesToday || 0);
    return Math.round(val * 100) / 100;
  }, [salesToday, todayRefunds, onlineSalesToday]);

  // ✅ NEW: Gross Total (Gross Cash + Online)
  const grossTotalToday = useMemo(() => {
    const val = Number(grossCashToday || 0) + Number(onlineSalesToday || 0);
    return Math.round(val * 100) / 100;
  }, [grossCashToday, onlineSalesToday]);

  // ---- Low Stock (✅ aggregated by name + brand; expiry/mrp ignored) ----
  const { lowStockItems, lowStockCount } = useMemo(() => {
    const items = (qInv.data || []) as any[];

    type Agg = {
      _key: string;
      name: string;
      brand: string | null;
      stock: number; // aggregated
      _variants: Array<{ id: number; mrp: number; expiry_date?: string | null; stock: number }>;
    };

    const map = new Map<string, Agg>();

    for (const it of items) {
      const name = String(it?.name ?? '').trim();
      const brand = it?.brand != null ? String(it.brand).trim() : null;
      const stock = Number(it?.stock ?? 0);
      const mrp = Number(it?.mrp ?? 0);

      if (!name) continue;

      const key = `${name.toLowerCase()}|${(brand ?? '').toLowerCase()}`;

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          _key: key,
          name,
          brand,
          stock: stock,
          _variants: [
            {
              id: Number(it?.id ?? 0),
              mrp,
              expiry_date: it?.expiry_date ?? null,
              stock,
            },
          ],
        });
      } else {
        existing.stock += stock;
        existing._variants.push({
          id: Number(it?.id ?? 0),
          mrp,
          expiry_date: it?.expiry_date ?? null,
          stock,
        });
      }
    }

    const aggregated = Array.from(map.values());

    const lows = aggregated
      .filter((it) => Number(it.stock || 0) <= LOW_STOCK_THRESH)
      .sort((a, b) => a.name.localeCompare(b.name));

    return { lowStockItems: lows, lowStockCount: lows.length };
  }, [qInv.data]);

  // ---- Expiring Soon (≤ 60 days) ----
  const { expiringSoonItems, expiringSoonCount } = useMemo(() => {
    const items = (qInv.data || []) as any[];
    const today = new Date();
    // normalize to midnight to avoid TZ off-by-ones
    today.setHours(0, 0, 0, 0);

    function daysUntil(exp: string | null | undefined) {
      if (!exp) return Infinity;
      // assume "YYYY-MM-DD" or ISO; force local midnight to be safe
      const d = new Date(
        String(exp).length <= 10 ? `${exp}T00:00:00` : String(exp)
      );
      if (isNaN(d.getTime())) return Infinity;
      d.setHours(0, 0, 0, 0);
      return Math.ceil((d.getTime() - today.getTime()) / 86400000);
    }

    const soon = items
      .map((it: any) => {
        const days = daysUntil(it.expiry_date);
        return { ...it, _daysLeft: days };
      })
      .filter(
        (it: any) =>
          it._daysLeft >= 0 && it._daysLeft <= EXPIRY_WINDOW_DAYS
      )
      .sort((a: any, b: any) => a._daysLeft - b._daysLeft); // closest first

    return { expiringSoonItems: soon, expiringSoonCount: soon.length };
  }, [qInv.data]);

  const cardBase = {
    p: 2.5,
    borderRadius: 3,
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between',
    gap: 0.5,
    boxShadow: '0 18px 40px rgba(0,0,0,0.04)',
    bgcolor: 'rgba(255,255,255,0.96)',
    backdropFilter: 'blur(4px)',
  };

  return (
    <Stack gap={2}>
      {/* Page title */}
      <Stack
        direction="row"
        alignItems="baseline"
        justifyContent="space-between"
        flexWrap="wrap"
        gap={1}
      >
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Quick Overview
        </Typography>
      </Stack>

      {/* Summary cards */}
      <Grid container spacing={2} alignItems="stretch">
        {/* Sensitive money cards: only when shortcut is active */}
        {showMoneyCards && (
          <>
            {/* TODAY'S SALES with hidden breakdown */}
            <Grid item xs={12} sm={6} md={3}>
              <Tooltip
                arrow
                placement="top"
                title={
                  <Stack spacing={0.5}>
                    <Typography variant="caption">
                      Cash: ₹{cashSalesToday.toFixed(2)}
                    </Typography>
                    <Typography variant="caption">
                      Online: ₹{onlineSalesToday.toFixed(2)}
                    </Typography>
                    <Typography variant="caption">
                      Gross Cash: ₹{grossCashToday.toFixed(2)}
                    </Typography>
                    {/* ✅ NEW */}
                    <Typography variant="caption">
                      Gross Total: ₹{grossTotalToday.toFixed(2)}
                    </Typography>
                  </Stack>
                }
              >
                <Paper
                  sx={{
                    ...cardBase,
                    cursor: 'pointer',
                    '&:hover': {
                      bgcolor: 'rgba(255,255,255,1)',
                      boxShadow: '0 20px 45px rgba(0,0,0,0.06)',
                    },
                  }}
                  onClick={() => setOpenSalesBreakdown(true)}
                >
                  <Typography variant="subtitle2" color="text.secondary">
                    Today’s Sales
                  </Typography>
                  <Typography
                    variant="h5"
                    sx={{
                      fontWeight: 600,
                      mt: 0.5,
                      fontSize: { xs: '1.3rem', md: '1.6rem' },
                    }}
                  >
                    ₹{salesToday.toFixed(2)}
                  </Typography>

                  {/* ✅ show Gross Total below Gross Cash */}
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 0.5 }}
                  >
                    Gross Cash: ₹{grossCashToday.toFixed(2)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Gross Total: ₹{grossTotalToday.toFixed(2)}
                  </Typography>
                </Paper>
              </Tooltip>
            </Grid>

            {/* RETURNS (still hidden behind shortcut) */}
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={cardBase}>
                <Typography variant="subtitle2" color="text.secondary">
                  Returns
                </Typography>
                <Typography
                  variant="h5"
                  sx={{
                    fontWeight: 600,
                    mt: 0.5,
                    fontSize: { xs: '1.3rem', md: '1.6rem' },
                  }}
                >
                  ₹{todayRefunds.toFixed(2)}
                </Typography>
              </Paper>
            </Grid>
          </>
        )}

        {/* Always visible cards */}
        <Grid item xs={12} sm={6} md={3}>
          <Tooltip title="Click to view low stock details">
            <Paper
              sx={{
                ...cardBase,
                cursor: 'pointer',
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,1)',
                  boxShadow: '0 20px 45px rgba(0,0,0,0.06)',
                },
              }}
              onClick={() => setOpenLow(true)}
            >
              <Typography variant="subtitle2" color="text.secondary">
                Low Stock
              </Typography>
              <Typography
                variant="h5"
                sx={{
                  fontWeight: 600,
                  mt: 0.5,
                  fontSize: { xs: '1.3rem', md: '1.6rem' },
                }}
              >
                {lowStockCount} items
              </Typography>
            </Paper>
          </Tooltip>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Tooltip title={`Items expiring within ${EXPIRY_WINDOW_DAYS} days`}>
            <Paper
              sx={{
                ...cardBase,
                cursor: 'pointer',
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,1)',
                  boxShadow: '0 20px 45px rgba(0,0,0,0.06)',
                },
              }}
              onClick={() => setOpenExp(true)}
            >
              <Typography variant="subtitle2" color="text.secondary">
                Expiring Soon
              </Typography>
              <Typography
                variant="h5"
                sx={{
                  fontWeight: 600,
                  mt: 0.5,
                  fontSize: { xs: '1.3rem', md: '1.6rem' },
                }}
              >
                {expiringSoonCount} items
              </Typography>
            </Paper>
          </Tooltip>
        </Grid>
      </Grid>

      {/* Today’s Sales breakdown dialog */}
      <Dialog
        open={openSalesBreakdown}
        onClose={() => setOpenSalesBreakdown(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Today’s Sales Breakdown</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Cash
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                ₹{cashSalesToday.toFixed(2)}
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Online
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                ₹{onlineSalesToday.toFixed(2)}
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between" mt={1}>
              <Typography variant="body2" color="text.secondary">
                Total
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                ₹{salesToday.toFixed(2)}
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Gross Cash
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                ₹{grossCashToday.toFixed(2)}
              </Typography>
            </Stack>

            {/* ✅ NEW */}
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Gross Total
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                ₹{grossTotalToday.toFixed(2)}
              </Typography>
            </Stack>
          </Stack>

          <Stack alignItems="flex-end" mt={2}>
            <Button onClick={() => setOpenSalesBreakdown(false)}>Close</Button>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* Low Stock dialog */}
      <Dialog
        open={openLow}
        onClose={() => setOpenLow(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Low Stock Items (≤ {LOW_STOCK_THRESH})</DialogTitle>
        <DialogContent>
          {lowStockItems.length === 0 ? (
            <Typography color="text.secondary" p={1}>
              All items are sufficiently stocked.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Brand</TableCell>
                  <TableCell align="right">Stock</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lowStockItems.map((it: any) => (
                  <TableRow key={it._key}>
                    <TableCell>{it.name}</TableCell>
                    <TableCell>{it.brand || '-'}</TableCell>
                    <TableCell align="right" sx={{ color: 'error.main' }}>
                      {it.stock}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Stack alignItems="flex-end" p={1}>
            <Button onClick={() => setOpenLow(false)}>Close</Button>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* Expiring Soon dialog */}
      <Dialog
        open={openExp}
        onClose={() => setOpenExp(false)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>Expiring Soon (≤ {EXPIRY_WINDOW_DAYS} days)</DialogTitle>
        <DialogContent>
          {expiringSoonItems.length === 0 ? (
            <Typography color="text.secondary" p={1}>
              No items expiring soon.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Brand</TableCell>
                  <TableCell>Expiry</TableCell>
                  <TableCell>Qty</TableCell>
                  <TableCell align="right">Days Left</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {expiringSoonItems.map((it: any) => (
                  <TableRow key={it._key}>
                    <TableCell>{it.name}</TableCell>
                    <TableCell>{it.brand || '-'}</TableCell>
                    <TableCell>{formatExpiry(it.expiry_date)}</TableCell>
                    <TableCell>{it.stock || '-'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>
                      {it._daysLeft}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Stack alignItems="flex-end" p={1}>
            <Button onClick={() => setOpenExp(false)}>Close</Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
