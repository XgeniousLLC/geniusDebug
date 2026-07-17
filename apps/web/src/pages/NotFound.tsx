import { StatusPage } from '../components/StatusPage';

export function NotFound() {
  return (
    <StatusPage
      code="404"
      title="Page not found"
      message="The page you're looking for doesn't exist, was moved, or the link is broken."
    />
  );
}
