import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { ErrorBoundary } from "@/components/error-boundary";

import LoginPage from "./pages/LoginPage";
import ImportEDIPage from "./pages/ImportEDIPage";
import OrdersPage from "./pages/OrdersPage";
import PalletizationPage from "./pages/PalletizationPage";
import LabelsPage from "./pages/LabelsPage";
import ArticlesPage from "./pages/ArticlesPage";
import ImportArticlesPage from "./pages/ImportArticlesPage";
import PackagingPage from "./pages/PackagingPage";
import LgLocationsPage from "./pages/LgLocationsPage";
import DeliverySitesPage from "./pages/DeliverySitesPage";
import PdArticleCodesPage from "./pages/PdArticleCodesPage";
import WarehouseAddressesPage from "./pages/WarehouseAddressesPage";
import HistoryPage from "./pages/HistoryPage";
import AdminPage from "./pages/AdminPage";
import AdminMaintenancePage from "./pages/AdminMaintenancePage";
import AccountSettingsPage from "./pages/AccountSettingsPage";
import Pallet3DPage from "./pages/Pallet3DPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const AppRoutes = () => {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<Navigate to="/import" replace />} />
          <Route path="/import" element={<ImportEDIPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/orders/:orderId" element={<PalletizationPage />} />
          <Route path="/palletization" element={<OrdersPage />} />
          <Route path="/paletizacao/:orderId/palete/:palletNumber/3d" element={<Pallet3DPage />} />
          <Route path="/labels" element={<LabelsPage />} />
          <Route path="/master/articles" element={<ArticlesPage />} />
          <Route path="/master/articles/import" element={<ImportArticlesPage />} />
          <Route path="/master/packaging" element={<PackagingPage />} />
          <Route path="/master/delivery-sites" element={<DeliverySitesPage />} />
          <Route path="/master/lg-locations" element={<LgLocationsPage />} />
          <Route path="/master/pd-article-codes" element={<PdArticleCodesPage />} />
          <Route path="/master/warehouse-addresses" element={<WarehouseAddressesPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/maintenance" element={<AdminMaintenancePage />} />
          <Route path="/definicoes" element={<AccountSettingsPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ErrorBoundary>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || undefined}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;