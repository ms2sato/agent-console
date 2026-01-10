import { createFileRoute } from '@tanstack/react-router';
import { SessionPage } from '../../../components/sessions/SessionPage';

export const Route = createFileRoute('/sessions/$sessionId/$workerId')({
  component: SessionWorkerPage,
});

/**
 * Route: /sessions/:sessionId/:workerId
 *
 * This route handles session URLs with a specific workerId.
 * The SessionPage component will:
 * - If workerId is valid: display that worker
 * - If workerId is invalid: redirect to /sessions/:sessionId (which will redirect to default)
 */
function SessionWorkerPage() {
  const { sessionId, workerId } = Route.useParams();

  return <SessionPage sessionId={sessionId} workerId={workerId} />;
}
