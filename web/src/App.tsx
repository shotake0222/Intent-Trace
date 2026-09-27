import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./lib/auth";
import { Spinner } from "./components/ui";
import Login from "./pages/Login";
import FieldLayout from "./pages/field/FieldLayout";
import FieldHome from "./pages/field/Home";
import TagLanding from "./pages/field/TagLanding";
import Inspect from "./pages/field/Inspect";
import Patrol from "./pages/field/Patrol";
import Deadman from "./pages/field/Deadman";
import ReportIncident from "./pages/field/ReportIncident";
import History from "./pages/field/History";
import Scan from "./pages/field/Scan";
import AdminLayout from "./pages/admin/AdminLayout";
import Dashboard from "./pages/admin/Dashboard";
import Analytics from "./pages/admin/Analytics";
import EquipmentAdmin from "./pages/admin/EquipmentAdmin";
import TagsAdmin from "./pages/admin/TagsAdmin";
import UsersAdmin from "./pages/admin/UsersAdmin";
import WorkflowsAdmin from "./pages/admin/WorkflowsAdmin";
import DevicesAdmin from "./pages/admin/DevicesAdmin";
import Records from "./pages/admin/Records";
import SitesAdmin from "./pages/admin/SitesAdmin";
import AccountAdmin from "./pages/admin/AccountAdmin";
import OpsLayout, { OpsLogin, ResetPassword } from "./pages/ops/OpsLayout";
import { OpsErrors, OpsNotifications } from "./pages/ops/OpsSecurity";
import OpsDashboard from "./pages/ops/OpsDashboard";
import OpsTenants from "./pages/ops/OpsTenants";
import OpsTenantDetail from "./pages/ops/OpsTenantDetail";
import OpsStock from "./pages/ops/OpsStock";
import OpsBilling from "./pages/ops/OpsBilling";
import { OpsAnnouncements, OpsAudit, OpsPlans, OpsSettings, OpsSupport } from "./pages/ops/OpsMisc";

function RequireAuth({ children, admin }: { children: React.ReactNode; admin?: boolean }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (!me && loading)
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (admin && me.role === "worker") return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <FieldLayout />
          </RequireAuth>
        }
      >
        <Route index element={<FieldHome />} />
        <Route path="t/:tagId" element={<TagLanding />} />
        <Route path="inspect/:equipmentId" element={<Inspect />} />
        <Route path="patrol" element={<Patrol />} />
        <Route path="deadman" element={<Deadman />} />
        <Route path="report" element={<ReportIncident />} />
        <Route path="history" element={<History />} />
        <Route path="scan" element={<Scan />} />
      </Route>
      <Route
        path="admin"
        element={
          <RequireAuth admin>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="equipment" element={<EquipmentAdmin />} />
        <Route path="tags" element={<TagsAdmin />} />
        <Route path="users" element={<UsersAdmin />} />
        <Route path="workflows" element={<WorkflowsAdmin />} />
        <Route path="devices" element={<DevicesAdmin />} />
        <Route path="records" element={<Records />} />
        <Route path="sites" element={<SitesAdmin />} />
        <Route path="account" element={<AccountAdmin />} />
      </Route>
      <Route path="ops/login" element={<OpsLogin />} />
      <Route path="ops/reset" element={<ResetPassword kind="ops" />} />
      <Route path="reset-password" element={<ResetPassword kind="user" />} />
      <Route path="ops" element={<OpsLayout />}>
        <Route index element={<OpsDashboard />} />
        <Route path="tenants" element={<OpsTenants />} />
        <Route path="tenants/:id" element={<OpsTenantDetail />} />
        <Route path="stock" element={<OpsStock />} />
        <Route path="billing" element={<OpsBilling />} />
        <Route path="plans" element={<OpsPlans />} />
        <Route path="announcements" element={<OpsAnnouncements />} />
        <Route path="support" element={<OpsSupport />} />
        <Route path="settings" element={<OpsSettings />} />
        <Route path="audit" element={<OpsAudit />} />
        <Route path="notifications" element={<OpsNotifications />} />
        <Route path="errors" element={<OpsErrors />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
