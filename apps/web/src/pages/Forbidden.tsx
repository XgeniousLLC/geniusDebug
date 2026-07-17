import { useNavigate } from 'react-router-dom';
import { StatusPage } from '../components/StatusPage';
import { Button } from '../components/ui';

export function Forbidden() {
  const navigate = useNavigate();
  return (
    <StatusPage
      code="403"
      title="Access denied"
      message="You don't have permission to view this page. This area is restricted to organization admins."
      actions={
        <Button variant="primary" size="sm" onClick={() => navigate('/dashboard')}>
          Back to dashboard
        </Button>
      }
    />
  );
}
