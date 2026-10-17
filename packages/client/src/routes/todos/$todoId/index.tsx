import { createFileRoute, Link, useNavigate, type ErrorComponentProps } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { fetchUsers } from '../../../lib/api';
import { userKeys } from '../../../lib/query-keys';
import { PageBreadcrumb } from '../../../components/PageBreadcrumb';
import { PagePendingFallback } from '../../../components/PagePendingFallback';
import { PageErrorFallback } from '../../../components/PageErrorFallback';
import { ErrorDialog, useErrorDialog } from '../../../components/ui/error-dialog';
import { TodoDetail } from '../../../components/todos/TodoDetail';
import { isTodoGone, useTodoDetail } from '../../../hooks/useTodoDetail';

export const Route = createFileRoute('/todos/$todoId/')({
  component: TodoDetailRoute,
  pendingComponent: TodoDetailPending,
  errorComponent: TodoDetailError,
  head: () => ({ meta: [{ title: 'Todo Details' }] }),
});

export function TodoDetailPending() {
  return <PagePendingFallback message="Loading Todo..." />;
}

export function TodoDetailError({ error, reset }: ErrorComponentProps) {
  return (
    <PageErrorFallback
      error={error}
      reset={reset}
      breadcrumbItems={[
        { label: 'Agent Console', to: '/' },
        { label: 'Todo', to: '/todos' },
        { label: 'Error' },
      ]}
      errorMessage="Failed to load Todo"
      backTo="/todos"
      backLabel="Back to Todo"
    />
  );
}

function TodoDetailRoute() {
  const { todoId } = Route.useParams();
  return <TodoDetailPage todoId={todoId} />;
}

/** The page identity of one Todo item. Run is never offered here: a terminal belongs to a session page. */
export function TodoDetailPage({ todoId }: { todoId: string }) {
  const navigate = useNavigate();
  const { errorDialogProps, showError } = useErrorDialog();
  const { data: detail, error } = useTodoDetail(todoId);
  const { data: users = [] } = useQuery({ queryKey: userKeys.list(), queryFn: fetchUsers });

  if (isTodoGone(error)) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <PageBreadcrumb items={[{ label: 'Agent Console', to: '/' }, { label: 'Todo', to: '/todos' }, { label: 'Not found' }]} />
        <div className="card text-center py-10">
          <p className="text-gray-400 mb-4">This Todo was deleted or does not exist</p>
          <Link to="/todos" className="btn btn-primary no-underline">
            Back to Todo
          </Link>
        </div>
      </div>
    );
  }

  // Any other failure is unexpected: let the route's error component show it.
  if (error) throw error;

  if (!detail) {
    return <PagePendingFallback message="Loading Todo..." />;
  }

  const { todo, activities } = detail;
  return (
    <div className="p-6 w-full max-w-4xl mx-auto">
      <PageBreadcrumb items={[{ label: 'Agent Console', to: '/' }, { label: 'Todo', to: '/todos' }, { label: todo.title }]} />
      <div className="card">
        <TodoDetail
          todo={todo}
          users={users}
          activities={activities}
          onError={showError}
          runEnabled={false}
          onDeleted={() => navigate({ to: '/todos' })}
        />
      </div>
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
