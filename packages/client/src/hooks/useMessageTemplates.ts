import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MessageTemplate } from '@agent-console/shared';
import {
  fetchMessageTemplates,
  createMessageTemplate,
  updateMessageTemplate,
  deleteMessageTemplate,
  reorderMessageTemplates,
} from '../lib/api';
import { messageTemplateKeys } from '../lib/query-keys';

export type { MessageTemplate };

export function useMessageTemplates() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: messageTemplateKeys.all(),
    queryFn: fetchMessageTemplates,
  });

  const templates = data?.templates ?? [];

  const addMutation = useMutation({
    mutationFn: ({ title, content }: { title: string; content: string }) =>
      createMessageTemplate(title, content),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: messageTemplateKeys.all() }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: { title?: string; content?: string } }) =>
      updateMessageTemplate(id, updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: messageTemplateKeys.all() }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMessageTemplate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: messageTemplateKeys.all() }),
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) => reorderMessageTemplates(orderedIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: messageTemplateKeys.all() }),
  });

  return {
    templates,
    addTemplate: (title: string, content: string) => addMutation.mutate({ title, content }),
    updateTemplate: (id: string, updates: Partial<Pick<MessageTemplate, 'title' | 'content'>>) =>
      updateMutation.mutate({ id, updates }),
    deleteTemplate: (id: string) => deleteMutation.mutate(id),
    reorderTemplates: (fromIndex: number, toIndex: number) => {
      const next = [...templates];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      reorderMutation.mutate(next.map(t => t.id));
    },
  } as const;
}
