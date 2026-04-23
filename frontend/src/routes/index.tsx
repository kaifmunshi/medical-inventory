// frontend/src/routes/index.tsx
import { Route, Routes, Navigate } from 'react-router-dom'
import AppLayout from '../components/layout/AppLayout'
import Dashboard from '../pages/Dashboard'
import Inventory from '../pages/Inventory'
import StockCardPage from '../pages/Inventory/StockCard'
import Billing from '../pages/Billing'
import Returns from '../pages/Returns'
import Exchange from '../pages/Returns/Exchange'
import Reports from '../pages/Reports/index'
import Settings from '../pages/Settings'
import RequestedItems from '../pages/RequestedItems/index'
import Customers from '../pages/Customers'
import CreditBills from '../pages/CreditBills' 
import CashbookPage from '../pages/Cashbook'
import BankBookPage from '../pages/BankBook'
import SalesBookPage from '../pages/SalesBook'
import ProductsPage from '../pages/Products'
import ProductCategoriesPage from '../pages/ProductCategories'
import BrandMasterPage from '../pages/BrandMaster'
import CustomerSummaryPage from '../pages/CustomerSummary'
import SuppliersPage from '../pages/Suppliers'
import PurchasesPage from '../pages/Purchases'
import StockAuditPage from '../pages/StockAudit'
import DayBookPage from '../pages/DayBook'
import LooseStockPage from '../pages/LooseStock'
import SupplierLedgerPage from '../pages/SupplierLedger'
import CustomerLedgerPage from '../pages/CustomerLedger'

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="inventory/stock-card" element={<StockCardPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="product-categories" element={<ProductCategoriesPage />} />
        <Route path="brand-master" element={<BrandMasterPage />} />
        <Route path="suppliers" element={<SuppliersPage />} />
        <Route path="billing" element={<Billing />} />
        <Route path="purchases" element={<PurchasesPage />} />
        <Route path="returns" element={<Returns />} />
        <Route path="exchange" element={<Exchange />} />
        <Route path="reports" element={<Reports />} />
        <Route path="credit-bills" element={<CreditBills />} /> {/* ✅ NEW */}
        <Route path="cashbook" element={<CashbookPage />} />
        <Route path="bank-book" element={<BankBookPage />} />
        <Route path="sales-book" element={<SalesBookPage />} />
        <Route path="day-book" element={<DayBookPage />} />
        <Route path="loose-stock" element={<LooseStockPage />} />
        <Route path="supplier-ledger" element={<SupplierLedgerPage />} />
        <Route path="customer-ledger" element={<CustomerLedgerPage />} />
        <Route path="stock-audit" element={<StockAuditPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="requested-items" element={<RequestedItems />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:customerId/summary" element={<CustomerSummaryPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
