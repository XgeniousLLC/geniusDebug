import { useNavigate } from 'react-router-dom';
import { useUi } from '../store/ui';
import { Button } from './ui';
import { ProjectsIcon } from './icons';

/**
 * Shown when the org has zero projects. Admins get a create CTA; members are
 * told to ask an admin. Used on the default landing surfaces so a fresh/empty
 * org is funnelled to create a project instead of seeing blank feeds.
 */
export function NoProject({ hint }: { hint?: string }) {
  const navigate = useNavigate();
  const isAdmin = useUi((s) => s.user?.role === 'admin');
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-surface/50 py-16 text-center">
      <div className="text-text-faint">
        <ProjectsIcon size={28} />
      </div>
      <div className="text-h2 font-semibold text-text">No projects yet</div>
      <div className="max-w-md text-small text-text-muted">
        {hint ?? 'A project holds its own errors, traces, replays and DSN. Create one to start capturing events.'}
      </div>
      {isAdmin ? (
        <Button variant="primary" size="sm" onClick={() => navigate('/projects?new=project')}>
          + New project
        </Button>
      ) : (
        <div className="text-caption text-text-faint">Ask an org admin to create the first project.</div>
      )}
    </div>
  );
}
