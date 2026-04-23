import type { ReactNode } from 'react'
import {
  AccountBalance,
  AccountBalanceWallet,
  AssignmentReturn,
  BarChart,
  Category,
  CreditCard,
  Dashboard,
  Factory,
  Inventory2,
  Menu as MenuIcon,
  MenuBook,
  People,
  PlaylistAddCheck,
  PointOfSale,
  ShoppingCart,
  ReceiptLong,
  Settings,
  SwapHoriz,
  FactCheck,
  Group,
  Assignment,
  LocalShipping,
  Inventory,
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
    icon: <Dashboard fontSize="small" />,
    items: [{ to: '/', label: 'Dashboard', icon: <Dashboard fontSize="small" />, hint: 'Overview and shortcuts', shortcut: 'Alt+D' }],
  },
  {
    key: 'masters',
    label: 'Masters',
    shortLabel: 'Masters',
    icon: <Inventory2 fontSize="small" />,
    items: [
      { to: '/inventory', label: 'Inventory', icon: <Inventory2 fontSize="small" />, hint: 'Item batches and stock' },
      { to: '/products', label: 'Manage Product', icon: <Inventory2 fontSize="small" />, hint: 'Product defaults and printed price' },
      { to: '/brand-master', label: 'Brand Master', icon: <Factory fontSize="small" />, hint: 'Self-maintained brand list' },
      { to: '/product-categories', label: 'Product Categories', icon: <Category fontSize="small" />, hint: 'Category master' },
      { to: '/suppliers', label: 'Supplier Master', icon: <People fontSize="small" />, hint: 'Sundry creditors and supplier setup' },
      { to: '/customers', label: 'Customers', icon: <People fontSize="small" />, hint: 'Customer directory and summaries' },
      { to: '/requested-items', label: 'Requested Items', icon: <PlaylistAddCheck fontSize="small" />, hint: 'Pending requests' },
    ],
  },
  {
    key: 'transactions',
    label: 'Transactions',
    shortLabel: 'Txn',
    icon: <PointOfSale fontSize="small" />,
    items: [
      { to: '/billing', label: 'Billing', icon: <PointOfSale fontSize="small" />, hint: 'Sales and billing' },
      { to: '/purchases', label: 'Purchase Order', icon: <ShoppingCart fontSize="small" />, hint: 'Supplier purchases and inward stock' },
      { to: '/returns', label: 'Returns', icon: <AssignmentReturn fontSize="small" />, hint: 'Returns and refunds' },
      { to: '/exchange', label: 'Exchange', icon: <SwapHoriz fontSize="small" />, hint: 'Exchange workflow' },
    ],
  },
  {
    key: 'books',
    label: 'Books',
    shortLabel: 'Books',
    icon: <ReceiptLong fontSize="small" />,
    items: [
      { to: '/cashbook', label: 'Cashbook', icon: <AccountBalanceWallet fontSize="small" />, hint: 'Cash movements and contra reflection' },
      { to: '/bank-book', label: 'Bank Book', icon: <AccountBalance fontSize="small" />, hint: 'UPI and bank register' },
      { to: '/credit-bills', label: 'Credit Bills', icon: <CreditCard fontSize="small" />, hint: 'Open and partial bills' },
      { to: '/sales-book', label: 'Sales Book', icon: <MenuBook fontSize="small" />, hint: 'Sales register' },
      { to: '/day-book', label: 'Day Book', icon: <ReceiptLong fontSize="small" />, hint: 'Voucher-style day register' },
      { to: '/customer-ledger', label: 'Customer Ledger', icon: <Group fontSize="small" />, hint: 'Debtor bills and receipts' },
      { to: '/supplier-ledger', label: 'Supplier Ledger', icon: <LocalShipping fontSize="small" />, hint: 'Supplier purchases and settlements' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    shortLabel: 'Reports',
    icon: <BarChart fontSize="small" />,
    items: [
      { to: '/reports', label: 'Reports Hub', icon: <BarChart fontSize="small" />, hint: 'Sales and stock reports' },
      { to: '/stock-audit', label: 'Stock Audit', icon: <FactCheck fontSize="small" />, hint: 'Rack-wise reconciliation and discrepancy posting' },
      { to: '/loose-stock', label: 'Loose Stock', icon: <Inventory fontSize="small" />, hint: 'Pack opening and loose stock control' },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    shortLabel: 'Admin',
    icon: <Settings fontSize="small" />,
    items: [
      { to: '/settings', label: 'Settings', icon: <Settings fontSize="small" />, hint: 'System settings' },
      { to: '/settings#users', label: 'Users & PIN', icon: <Assignment fontSize="small" />, hint: 'Staff roles and PIN control' },
    ],
  },
]

export const quickShortcutItems = appMenuGroups.flatMap((group) => group.items).filter((item) => item.shortcut)
export const allMenuItems = appMenuGroups.flatMap((group) => group.items)
export const mobileMenuIcon = <MenuIcon fontSize="small" />
