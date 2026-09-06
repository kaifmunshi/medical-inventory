// frontend/src/routes/index.tsx
import { lazy, Suspense, type ReactNode } from 'react'
import { Route, Routes, Navigate, useLocation } from 'react-router-dom'
import AppLayout from '../components/layout/AppLayout'
import { useUserSession } from '../components/session/UserSessionProvider'
import { isLockAllowedPath } from '../lib/sessionLock'
import Loading from '../components/ui/Loading'

const Dashboard = lazy(() => import('../pages/Dashboard'))
const Inventory = lazy(() => import('../pages/Inventory'))
const StockCardPage = lazy(() => import('../pages/Inventory/StockCard'))
const Billing = lazy(() => import('../pages/Billing'))
const Returns = lazy(() => import('../pages/Returns'))
const Exchange = lazy(() => import('../pages/Returns/Exchange'))
const Reports = lazy(() => import('../pages/Reports/index'))
const Settings = lazy(() => import('../pages/Settings'))
const RequestedItems = lazy(() => import('../pages/RequestedItems/index'))
const Customers = lazy(() => import('../pages/Customers'))
const CreditBills = lazy(() => import('../pages/CreditBills'))
const CashbookPage = lazy(() => import('../pages/Cashbook'))
const BankBookPage = lazy(() => import('../pages/BankBook'))
const SalesBookPage = lazy(() => import('../pages/SalesBook'))
const ProductsPage = lazy(() => import('../pages/Products'))
const ProductCategoriesPage = lazy(() => import('../pages/ProductCategories'))
const BrandMasterPage = lazy(() => import('../pages/BrandMaster'))
const CustomerSummaryPage = lazy(() => import('../pages/CustomerSummary'))
const SuppliersPage = lazy(() => import('../pages/Suppliers'))
const PurchasesPage = lazy(() => import('../pages/Purchases'))
const PurchaseReturnsPage = lazy(() => import('../pages/PurchaseReturns'))
const StockAuditPage = lazy(() => import('../pages/StockAudit'))
const DayBookPage = lazy(() => import('../pages/DayBook'))
const JournalEntryPage = lazy(() => import('../pages/JournalEntry'))
const LooseStockPage = lazy(() => import('../pages/LooseStock'))
const SupplierLedgerPage = lazy(() => import('../pages/SupplierLedger'))
const CustomerLedgerPage = lazy(() => import('../pages/CustomerLedger'))
const SuspenseAccountPage = lazy(() => import('../pages/SuspenseAccount'))
const LoansAdvancesPage = lazy(() => import('../pages/LoansAdvances'))

function SessionAccessRoute({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { currentUser, isLocked } = useUserSession()
  const isOwner = currentUser?.role === 'OWNER'

  if (((currentUser && !isOwner) || isLocked) && !isLockAllowedPath(location.pathname)) {
    return <Navigate to="/inventory" replace />
  }

  return <>{children}</>
}

export default function AppRoutes() {
  return (
    <Suspense fallback={<Loading label="Opening page…" hint="Loading only what this page needs" />}>
    <Routes>
      <Route
        path="/"
        element={(
          <SessionAccessRoute>
            <AppLayout />
          </SessionAccessRoute>
        )}
      >
        <Route index element={<Dashboard />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="inventory/stock-card" element={<StockCardPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="product-categories" element={<ProductCategoriesPage />} />
        <Route path="brand-master" element={<BrandMasterPage />} />
        <Route path="suppliers" element={<SuppliersPage />} />
        <Route path="billing" element={<Billing />} />
        <Route path="purchases" element={<PurchasesPage />} />
        <Route path="purchase-returns" element={<PurchaseReturnsPage />} />
        <Route path="returns" element={<Returns />} />
        <Route path="exchange" element={<Exchange />} />
        <Route path="reports" element={<Reports />} />
        <Route path="credit-bills" element={<CreditBills />} /> {/* ✅ NEW */}
        <Route path="cashbook" element={<CashbookPage />} />
        <Route path="bank-book" element={<BankBookPage />} />
        <Route path="sales-book" element={<SalesBookPage />} />
        <Route path="day-book" element={<DayBookPage />} />
        <Route path="journal-entry" element={<JournalEntryPage />} />
        <Route path="loose-stock" element={<LooseStockPage />} />
        <Route path="supplier-ledger" element={<SupplierLedgerPage />} />
        <Route path="suspense-account" element={<SuspenseAccountPage />} />
        <Route path="customer-ledger" element={<CustomerLedgerPage />} />
        <Route path="loans-advances" element={<LoansAdvancesPage />} />
        <Route path="stock-audit" element={<StockAuditPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="requested-items" element={<RequestedItems />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:customerId/summary" element={<CustomerSummaryPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  )
}
