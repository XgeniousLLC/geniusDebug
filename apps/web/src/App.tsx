import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useUi } from './store/ui';
import { getToken } from './lib/api';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Issues } from './pages/Issues';
import { IssueDetail } from './pages/IssueDetail';
import { Traces } from './pages/Traces';
import { Replays } from './pages/Replays';
import { ReplayPlayer } from './pages/ReplayPlayer';
import { Alerts } from './pages/Alerts';
import { Settings } from './pages/Settings';

function RequireAuth({ children }: { children: JSX.Element }) {
  const user = useUi((s) => s.user);
  const location = useLocation();
  if (!user || !getToken()) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/issues" replace />} />
      <Route path="/issues" element={<RequireAuth><Issues /></RequireAuth>} />
      <Route path="/issues/:shortId" element={<RequireAuth><IssueDetail /></RequireAuth>} />
      <Route path="/traces" element={<RequireAuth><Traces /></RequireAuth>} />
      <Route path="/traces/:traceId" element={<RequireAuth><Traces /></RequireAuth>} />
      <Route path="/replays" element={<RequireAuth><Replays /></RequireAuth>} />
      <Route path="/replays/:replayId" element={<RequireAuth><ReplayPlayer /></RequireAuth>} />
      <Route path="/alerts" element={<RequireAuth><Alerts /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/issues" replace />} />
    </Routes>
  );
}
