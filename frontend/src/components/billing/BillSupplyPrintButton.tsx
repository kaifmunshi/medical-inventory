import { Button, Tooltip } from '@mui/material'
import PrintIcon from '@mui/icons-material/Print'
import type { Bill } from '../../services/billing'

const SHOP_NAME = 'Goodluck Ayurvedic and Unani Store'
const SHOP_GSTIN = '24ATGPS0801G1Z1'
const SELLER_STATUS = 'Composition Taxable Person'
const TAX_NOTICE = 'No taxes collected'

type Props = {
  bill: Bill | any
  label?: string
  size?: 'small' | 'medium' | 'large'
  variant?: 'text' | 'outlined' | 'contained'
  disabled?: boolean
  fullWidth?: boolean
}

function money(n: number | string | undefined | null) {
  return Number(n || 0).toFixed(2)
}

function escapeHtml(raw: any) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatDateTime(raw: any) {
  const text = String(raw || '').trim()
  if (!text) return '-'
  const normalized = text.replace(' ', 'T')
  const dt = new Date(normalized.length === 10 ? `${normalized}T00:00:00` : normalized)
  if (Number.isNaN(dt.getTime())) return text
  const dateText = dt.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  if (dt.getHours() === 0 && dt.getMinutes() === 0 && dt.getSeconds() === 0) return dateText
  const timeText = dt.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${dateText}, ${timeText}`
}

function parseBillNotes(raw: any) {
  const lines = String(raw || '').split(/\r?\n/)
  const first = String(lines[0] || '').trim()
  if (!/^customer\s*:/i.test(first)) {
    return { customer: '', freeNotes: String(raw || '').trim() }
  }
  const customer = first.replace(/^customer\s*:\s*/i, '').trim()
  return {
    customer,
    freeNotes: lines.slice(1).join('\n').trim(),
  }
}

function uniqueParts(parts: Array<string | null | undefined>) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const value = String(part || '').trim()
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function packLine(item: any) {
  const isLoose = Boolean(item?.is_loose_stock)
  const stockUnit = String(item?.stock_unit_label || '').trim()
  const parent = String(item?.parent_unit_name || '').trim()
  const child = String(item?.child_unit_name || '').trim()
  const conversion = Number(item?.conversion_qty || 0)

  const parts = uniqueParts([
    item?.brand ? `Brand: ${item.brand}` : 'Brand: -',
    isLoose
      ? `Unit: ${child || stockUnit || 'Loose'}`
      : (stockUnit || parent ? `Pack: ${stockUnit || parent}` : ''),
    parent && child && conversion > 0 ? `${parent} = ${conversion} ${child}` : '',
  ])
  return parts.join(' | ')
}

function paymentLabel(bill: any) {
  const mode = String(bill?.payment_mode || '').trim().toUpperCase()
  const status = String(bill?.payment_status || '').trim().toUpperCase()
  return uniqueParts([mode || '-', status || '-']).join(' / ')
}

function buildPrintHtml(bill: Bill | any, logoUrl: string) {
  const items = Array.isArray(bill?.items) ? bill.items : []
  const notes = parseBillNotes(bill?.notes)
  const billFileName = `Bill-${String(bill?.id || 'new').replace(/[^\w-]/g, '')}`
  const grossMrp = items.reduce((sum: number, item: any) => {
    return sum + Number(item?.quantity || 0) * Number(item?.mrp || 0)
  }, 0)
  const lineTotal = items.reduce((sum: number, item: any) => sum + Number(item?.line_total || 0), 0)
  const billTotal = Number(bill?.total_amount || 0)
  const discount = Math.max(0, grossMrp - lineTotal)
  const adjustment = Number((billTotal - lineTotal).toFixed(2))
  const paid = Number(bill?.paid_amount ?? (Number(bill?.payment_cash || 0) + Number(bill?.payment_online || 0)))
  const writeoff = Number(bill?.writeoff_amount || 0)
  const pending = Math.max(0, billTotal - paid - writeoff)
  const customer = notes.customer || (bill?.customer_id ? `Customer ID #${bill.customer_id}` : 'Walk-in Customer')
  const deletedBanner = bill?.is_deleted
    ? `<div class="deleted-banner">Cancelled / Deleted Bill${bill?.deleted_at ? ` on ${escapeHtml(formatDateTime(bill.deleted_at))}` : ''}</div>`
    : ''

  const rows = items.map((item: any, index: number) => {
    const qty = Number(item?.quantity || 0)
    const amount = Number(item?.line_total || 0)
    const rate = qty > 0 ? amount / qty : 0
    const name = item?.item_name || item?.name || item?.item?.name || `Item #${item?.item_id || ''}`
    const categoryName = String(item?.category_name || '').trim()
    const printedName = categoryName ? `${categoryName} - ${name}` : name
    return `
      <tr>
        <td class="center">${index + 1}</td>
        <td>
          <div class="item-name">${escapeHtml(printedName)}</div>
          <div class="muted small">${escapeHtml(packLine(item))}</div>
        </td>
        <td class="num">${escapeHtml(money(item?.mrp))}</td>
        <td class="center">${escapeHtml(qty)}</td>
        <td class="num">${escapeHtml(money(rate))}</td>
        <td class="num">${escapeHtml(money(amount))}</td>
      </tr>
    `
  }).join('')

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(billFileName)}</title>
    <style>
      @page { size: A4; margin: 0; }
      * { box-sizing: border-box; }
      html,
      body {
        width: 210mm;
        height: 297mm;
        margin: 0;
      }
      body {
        color: #151515;
        background: #fff;
        font-family: "Times New Roman", Georgia, serif;
        font-size: 12px;
        padding: 8mm;
      }
      .sheet {
        width: 100%;
        height: 274mm;
        border: 1.8px solid #111;
        padding: 10px 11px;
        display: flex;
        flex-direction: column;
        break-after: avoid;
        page-break-after: avoid;
      }
      .brand-header {
        display: grid;
        grid-template-columns: 178px 1fr 178px;
        align-items: center;
        gap: 10px;
        border-bottom: 1.8px solid #111;
        padding-bottom: 7px;
      }
      .seller-box {
        align-self: stretch;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
      }
      .logo-box {
        min-height: 68px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      .logo-box img {
        max-width: 100%;
        max-height: 68px;
        object-fit: contain;
        display: block;
      }
      .store-name {
        text-align: center;
        text-transform: uppercase;
        letter-spacing: 0.7px;
        font-size: 23px;
        font-weight: 800;
        line-height: 1.08;
      }
      .seller-status {
        text-align: left;
        font-size: 12px;
        font-weight: 700;
      }
      .gst-line {
        margin-top: 4px;
        text-align: left;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.25px;
      }
      .tax-notice {
        margin-top: 5px;
        display: inline-block;
        border: 1px solid #111;
        padding: 2px 10px;
        font-size: 10.5px;
        font-weight: 800;
        text-transform: uppercase;
        text-align: center;
        align-self: flex-start;
      }
      .doc-title {
        text-align: left;
        text-transform: uppercase;
        letter-spacing: 0.9px;
        font-size: 17px;
        font-weight: 900;
        margin-bottom: 6px;
      }
      .deleted-banner {
        margin-top: 6px;
        border: 1px solid #991b1b;
        color: #991b1b;
        padding: 4px 8px;
        text-align: center;
        font-size: 12px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.7px;
      }
      .boxline {
        border-bottom: 1px solid #b9b9b9;
        padding: 3px 0;
      }
      .meta {
        padding: 10px 0;
        border-bottom: 1px solid #111;
      }
      .label {
        color: #444;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }
      .value {
        margin-top: 2px;
        font-weight: 700;
      }
      .line-section {
        flex: 1 1 auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
      }
      th, td {
        border: 1px solid #111;
        padding: 5px 7px;
        vertical-align: top;
      }
      th {
        background: #efefef;
        font-family: Arial, Helvetica, sans-serif;
        text-transform: uppercase;
        font-size: 10.5px;
        letter-spacing: 0.35px;
      }
      .item-name {
        font-weight: 700;
      }
      .small {
        font-size: 10.5px;
      }
      .muted {
        color: #555;
      }
      .center {
        text-align: center;
      }
      .num {
        text-align: right;
        white-space: nowrap;
      }
      .bottom-panel {
        margin-top: auto;
        padding-top: 10px;
      }
      .summary {
        display: grid;
        grid-template-columns: 1fr 260px;
        gap: 18px;
        align-items: stretch;
      }
      .summary-table {
        margin-top: 0;
      }
      .summary-table td {
        padding: 5px 8px;
      }
      .grand td {
        border-top: 2px solid #111;
        border-bottom: 2px solid #111;
        font-size: 16px;
        font-weight: 900;
      }
      .note-box {
        border: 1px solid #111;
        min-height: 72px;
        padding: 8px;
      }
      .footer {
        display: grid;
        grid-template-columns: 1fr 210px;
        gap: 18px;
        margin-top: 14px;
        align-items: end;
      }
      .signature {
        border-top: 1px solid #111;
        padding-top: 8px;
        text-align: center;
        font-weight: 700;
      }
      .declaration {
        border-top: 1px solid #b9b9b9;
        padding-top: 8px;
        color: #333;
        line-height: 1.45;
      }
      @media print {
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
    </style>
  </head>
  <body>
    <div class="sheet">
      <div class="brand-header">
        <div class="seller-box">
          <div class="doc-title">Bill of Supply</div>
          <div class="seller-status">${escapeHtml(SELLER_STATUS)}</div>
          <div class="gst-line">GSTIN : ${escapeHtml(SHOP_GSTIN)}</div>
          <div class="tax-notice">${escapeHtml(TAX_NOTICE)}</div>
          ${deletedBanner}
        </div>
        <div style="text-align:center">
          <div class="logo-box">
            <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(SHOP_NAME)} logo" />
          </div>
        </div>
        <div>
          <div class="boxline"><span class="label">Bill No.</span> <b>${escapeHtml(bill?.bill_number || bill?.id || '-')}</b></div>
          <div class="boxline"><span class="label">Date</span> <b>${escapeHtml(formatDateTime(bill?.date_time))}</b></div>
          <div class="boxline"><span class="label">Payment</span> <b>${escapeHtml(paymentLabel(bill))}</b></div>
        </div>
      </div>

      <div class="meta">
        <div>
          <div class="label">Bill To</div>
          <div class="value">${escapeHtml(customer)}</div>
        </div>
      </div>

      <div class="line-section">
        <table>
          <thead>
            <tr>
              <th style="width:42px">No.</th>
              <th>Product</th>
              <th style="width:82px">MRP</th>
              <th style="width:62px">Qty</th>
              <th style="width:82px">Rate</th>
              <th style="width:96px">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="6" class="center muted">No items</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="bottom-panel">
        <div class="summary">
          <div class="note-box">
            <div class="label">Notes</div>
            <div>${escapeHtml(notes.freeNotes || '-').replace(/\n/g, '<br />')}</div>
          </div>
          <table class="summary-table">
            <tbody>
              <tr><td>MRP Total</td><td class="num">${escapeHtml(money(grossMrp))}</td></tr>
              <tr><td>Discount</td><td class="num">${escapeHtml(money(discount))}</td></tr>
              ${Math.abs(adjustment) > 0.009 ? `<tr><td>Round / Adjustment</td><td class="num">${escapeHtml(money(adjustment))}</td></tr>` : ''}
              <tr><td>Tax</td><td class="num">0.00</td></tr>
              <tr class="grand"><td>Total</td><td class="num">${escapeHtml(money(billTotal))}</td></tr>
              <tr><td>Paid</td><td class="num">${escapeHtml(money(paid))}</td></tr>
              ${writeoff > 0 ? `<tr><td>Write-off</td><td class="num">${escapeHtml(money(writeoff))}</td></tr>` : ''}
              <tr><td>Balance</td><td class="num">${escapeHtml(money(pending))}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="footer">
          <div class="declaration">
            This is a Bill of Supply issued by a ${escapeHtml(SELLER_STATUS)}. ${escapeHtml(TAX_NOTICE)}.
          </div>
          <div class="signature">Authorised Signature</div>
        </div>
      </div>
    </div>
    <script>
      window.addEventListener('load', function () {
        window.focus();
        setTimeout(function () { window.print(); }, 150);
      });
    </script>
  </body>
</html>`
}

export default function BillSupplyPrintButton({
  bill,
  label = 'Print',
  size = 'small',
  variant = 'outlined',
  disabled,
  fullWidth,
}: Props) {
  function printBill() {
    if (!bill?.id) return
    const win = window.open('', '_blank', 'width=900,height=1200')
    if (!win) return
    const logoUrl = new URL('/logo.png', window.location.origin).href
    win.document.open()
    win.document.write(buildPrintHtml(bill, logoUrl))
    win.document.close()
  }

  const button = (
    <Button
      type="button"
      size={size}
      variant={variant}
      startIcon={<PrintIcon />}
      onClick={printBill}
      disabled={disabled || !bill?.id}
      fullWidth={fullWidth}
      aria-label={bill?.id ? `Print bill ${bill.bill_number || bill.id}` : 'Print bill'}
      sx={{
        minWidth: fullWidth ? undefined : 86,
        height: size === 'medium' ? 36 : 32,
        px: 1.25,
        borderRadius: 1.25,
        fontWeight: 700,
        letterSpacing: 0,
        whiteSpace: 'nowrap',
        ...(variant === 'outlined'
          ? {
              color: 'text.primary',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              '&:hover': {
                borderColor: 'primary.main',
                bgcolor: 'rgba(31, 107, 74, 0.06)',
              },
            }
          : {}),
        ...(variant === 'contained'
          ? {
              boxShadow: 'none',
              '&:hover': { boxShadow: 'none' },
            }
          : {}),
        '& .MuiButton-startIcon': {
          mr: 0.75,
          ml: 0,
        },
      }}
    >
      {label}
    </Button>
  )

  return (
    <Tooltip title={bill?.id ? `Print Bill #${bill.bill_number || bill.id}` : 'Print bill'} arrow>
      <span>{button}</span>
    </Tooltip>
  )
}
