import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Card, Skeleton } from '../components/ui';
import { IntegrationGuide, type GuideProject } from '../components/IntegrationGuide';
import { NotFound } from './NotFound';
import { Forbidden } from './Forbidden';

interface Project extends GuideProject {
  slug: string;
  platform: string;
  ingestEnabled: boolean;
}

/** Focused onboarding page — landed on right after creating a project. */
export function ProjectSetup() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const project = projects.data?.find((p) => p.id === id);

  if (projects.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (projects.isError && projects.error instanceof ApiError && projects.error.status === 403) return <Forbidden />;
  if (!project) return <NotFound />;

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-1 text-caption text-text-faint">
        <Link to="/projects" className="hover:text-accent">Projects</Link> / Setup
      </div>
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-h1 font-semibold">Set up {project.name}</h1>
        <span className="rounded bg-accent/15 px-2 py-0.5 text-caption text-accent">new project</span>
      </div>
      <p className="mb-5 text-small text-text-muted">
        Wire the SDK below to start capturing errors. You can always return to this from the project's{' '}
        <Link to="/projects" className="text-accent hover:underline">Setup guide</Link>.
      </p>

      <Card className="p-5">
        <IntegrationGuide project={project} onChanged={() => qc.invalidateQueries({ queryKey: ['projects'] })} />
      </Card>

      <div className="mt-5 flex gap-2">
        <Button variant="primary" size="sm" onClick={() => navigate('/dashboard')}>Go to dashboard</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/projects')}>Back to projects</Button>
      </div>
    </div>
  );
}
