import { createFileRoute } from '@tanstack/react-router';
import { TodosPage } from '../../components/todos/TodosPage';

export const Route = createFileRoute('/todos/')({
  component: TodosPage,
  head: () => ({
    meta: [{ title: 'Todo' }],
  }),
});
