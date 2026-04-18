import type { ReactNode } from 'react'
import {
  AdminPanelSettings,
  AccountBalanceWallet,
  AccountTree,
  AssignmentReturn,
  Balance,
  BarChart,
  Category,
  CreditCard,
  Dashboard,
  Inventory2,
  LocalShipping,
  Menu as MenuIcon,
  MenuBook,
  People,
  PersonSearch,
  PlaylistAddCheck,
  PointOfSale,
  ReceiptLong,
  Settings,
  ShoppingCart,
  SwapHoriz,
  Unarchive,
  KeyboardCommandKey,
  FactCheck,
} from '@mui/icons-material'

export type AppMenuItem = {
  to: string
  label: string
  icon: ReactNode
  hint?: string
  shortcut?: string
}

export type AppMenuGroup = {
  key: string
  label: string
  shortLabel?: string
  hint?: string
  icon?: ReactNode
  shortcut?: string
  items: AppMenuItem[]
}

export const appMenuGroups: AppMenuGroup[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    shortLabel: 'Home',
    hint: 'Store overview and quick status',
    icon: <Dashboard fontSize="small" />,
    shortcut: 'Alt+D',
    items: [{ to: '/', label: 'Dashboard', icon: <Dashboard fontSize="small" />, hint: 'Overview and shortcuts', shortcut: 'Alt+D' }],
  },
  {
    key: 'masters',
    label: 'Masters',
    shortLabel: 'Masters',
    hint: 'Maintain products and parties',
    icon: <Inventory2 fontSize="small" />,
    shortcut: 'Alt+M',
    items: [
      { to: '/inventory', label: 'Manage Products', icon: <Inventory2 fontSize="small" />, hint: 'Stock masters and batches', shortcut: 'Alt+I' },
      { to: '/products', label: 'Products', icon: <Inventory2 fontSize="small" />, hint: 'Product names, aliases, brands and loose-sale defaults', shortcut: 'Alt+N' },
      { to: '/product-categories', label: 'Product Categories', icon: <Category fontSize="small" />, hint: 'Custom medicine category master', shortcut: 'Alt+F' },
      { to: '/customers', label: 'Customers', icon: <People fontSize="small" />, hint: 'Debtors and buyer details', shortcut: 'Alt+U' },
      { to: '/stock-audit', label: 'Stock Audit', icon: <FactCheck fontSize="small" />, hint: 'Reconcile physical inventory', shortcut: 'Alt+A' },
      { to: '/suppliers', label: 'Suppliers', icon: <LocalShipping fontSize="small" />, hint: 'Creditors and vendor details', shortcut: 'Alt+S' },
      { to: '/requested-items', label: 'Requested Items', icon: <PlaylistAddCheck fontSize="small" />, hint: 'Pending customer requests', shortcut: 'Alt+Q' },
    ],
  },
  {
    key: 'transactions',
    label: 'Transactions',
    shortLabel: 'Txn',
    hint: 'Daily store operations',
    icon: <PointOfSale fontSize="small" />,
    shortcut: 'Alt+T',
    items: [
      { to: '/billing', label: 'Billing', icon: <PointOfSale fontSize="small" />, hint: 'Sales and invoices', shortcut: 'Alt+B' },
      { to: '/purchases', label: 'Purchases', icon: <ShoppingCart fontSize="small" />, hint: 'Supplier purchase entries', shortcut: 'Alt+P' },
      { to: '/returns', label: 'Returns', icon: <AssignmentReturn fontSize="small" />, hint: 'Sales returns and refunds', shortcut: 'Alt+R' },
      { to: '/exchange', label: 'Exchange', icon: <SwapHoriz fontSize="small" />, hint: 'Combined return and rebill', shortcut: 'Alt+E' },
      { to: '/loose-stock', label: 'Loose Stock', icon: <Unarchive fontSize="small" />, hint: 'Open and track loose stock', shortcut: 'Alt+L' },
      { to: '/cashbook', label: 'Cashbook', icon: <AccountBalanceWallet fontSize="small" />, hint: 'Manual cash movements', shortcut: 'Alt+K' },
    ],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    shortLabel: 'Accounts',
    hint: 'Ledgers and books',
    icon: <Balance fontSize="small" />,
    shortcut: 'Alt+A',
    items: [
      { to: '/customer-ledger', label: 'Customer Ledger', icon: <PersonSearch fontSize="small" />, hint: 'Debtor balances and receipts', shortcut: 'Alt+Y' },
      { to: '/supplier-ledger', label: 'Supplier Ledger', icon: <AccountTree fontSize="small" />, hint: 'Creditor balances and payments', shortcut: 'Alt+G' },
      { to: '/credit-bills', label: 'Credit Bills', icon: <CreditCard fontSize="small" />, hint: 'Open and partial customer bills', shortcut: 'Alt+C' },
      { to: '/day-book', label: 'Day Book', icon: <ReceiptLong fontSize="small" />, hint: 'Chronological voucher flow', shortcut: 'Alt+J' },
      { to: '/accounting', label: 'Accounting', icon: <Balance fontSize="small" />, hint: 'Posted vouchers and ledgers', shortcut: 'Alt+O' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    shortLabel: 'Reports',
    hint: 'Analysis and books',
    icon: <BarChart fontSize="small" />,
    shortcut: 'Alt+H',
    items: [
      { to: '/reports', label: 'Reports Hub', icon: <BarChart fontSize="small" />, hint: 'Sales, stock and returns reports', shortcut: 'Alt+Z' },
      { to: '/sales-book', label: 'Sales Book', icon: <MenuBook fontSize="small" />, hint: 'Daily sales register', shortcut: 'Alt+V' },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    shortLabel: 'Admin',
    hint: 'Controls and locks',
    icon: <AdminPanelSettings fontSize="small" />,
    shortcut: 'Alt+N',
    items: [
      { to: '/settings', label: 'Settings', icon: <Settings fontSize="small" />, hint: 'Financial years and audit trail', shortcut: 'Alt+X' },
      { to: '/shortcuts', label: 'Shortcuts', icon: <KeyboardCommandKey fontSize="small" />, hint: 'Read-only keyboard reference', shortcut: 'Alt+/' },
    ],
  },
]

export const quickShortcutItems = appMenuGroups.flatMap((group) => group.items).filter((item) => item.shortcut)
export const mobileMenuIcon = <MenuIcon fontSize="small" />
