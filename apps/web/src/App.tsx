import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useUi } from './store/ui';
import { getToken } from './lib/api';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Forgot } from './pages/Forgot';
import { Reset } from './pages/Reset';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Issues } from './pages/Issues';
import { IssueDetail } from './pages/IssueDetail';
import { Traces } from './pages/Traces';
import { Replays } from './pages/Replays';
import { Releases } from './pages/Releases';
import { Performance } from './pages/Performance';
import { ReplayPlayer } from './pages/ReplayPlayer';
import { Alerts } from './pages/Alerts';
import { Projects } from './pages/Projects';
import { ProjectSetup } from './pages/ProjectSetup';
import { Settings } from './pages/Settings';
import { NotFound } from './pages/NotFound';
import { Share } from './pages/Share';
import { Forbidden } from './pages/Forbidden';
import { AccountProfile } from './pages/AccountProfile';
import { AccountPassword } from './pages/AccountPassword';

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
      <Route path="/share/:token" element={<Share />} />
      <Route path="/forgot" element={<Forgot />} />
      <Route path="/reset" element={<Reset />} />
      <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/issues" element={<RequireAuth><Issues /></RequireAuth>} />
      <Route path="/issues/:shortId" element={<RequireAuth><IssueDetail /></RequireAuth>} />
      <Route path="/traces" element={<RequireAuth><Traces /></RequireAuth>} />
      <Route path="/traces/:traceId" element={<RequireAuth><Traces /></RequireAuth>} />
      <Route path="/replays" element={<RequireAuth><Replays /></RequireAuth>} />
      <Route path="/releases" element={<RequireAuth><Releases /></RequireAuth>} />
      <Route path="/performance" element={<RequireAuth><Performance /></RequireAuth>} />
      <Route path="/replays/:replayId" element={<RequireAuth><ReplayPlayer /></RequireAuth>} />
      <Route path="/alerts" element={<RequireAuth><Alerts /></RequireAuth>} />
      <Route path="/projects" element={<RequireAuth><Projects /></RequireAuth>} />
      <Route path="/projects/:id/setup" element={<RequireAuth><ProjectSetup /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      <Route path="/account" element={<Navigate to="/account/profile" replace />} />
      <Route path="/account/profile" element={<RequireAuth><AccountProfile /></RequireAuth>} />
      <Route path="/account/password" element={<RequireAuth><AccountPassword /></RequireAuth>} />
      <Route path="/403" element={<RequireAuth><Forbidden /></RequireAuth>} />
      <Route path="*" element={<RequireAuth><NotFound /></RequireAuth>} />
    </Routes>
  );
}
