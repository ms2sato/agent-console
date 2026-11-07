import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateInboundWebhookEndpointRequest,
  UpdateInboundWebhookEndpointRequest,
} from '@agent-console/shared';
import {
  clearInboundWebhookEndpointPreviousSecret,
  createInboundWebhookEndpoint,
  deleteInboundWebhookEndpoint,
  fetchInboundWebhookEndpoints,
  rotateInboundWebhookEndpointSecret,
  updateInboundWebhookEndpoint,
} from '../../../lib/api';
import { inboundWebhookEndpointKeys } from '../../../lib/query-keys';

/** A freshly issued signing secret. It exists only in the caller's state. */
export interface IssuedSecret {
  endpointId: string;
  label: string;
  secret: string;
}

export function useInboundWebhookEndpointsQuery() {
  return useQuery({
    queryKey: inboundWebhookEndpointKeys.all(),
    queryFn: fetchInboundWebhookEndpoints,
  });
}

/**
 * Mutations for inbound webhook endpoints.
 *
 * create and rotate responses carry the signing secret. It is handed to
 * `onSecretIssued` inside the mutation function and stripped from what the
 * mutation returns, so it never lands in the mutation cache or the list query
 * cache; `gcTime: 0` additionally drops mutation state when unobserved.
 */
export function useInboundWebhookEndpointMutations(onSecretIssued: (issued: IssuedSecret) => void) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: inboundWebhookEndpointKeys.all() });

  const create = useMutation({
    gcTime: 0,
    mutationFn: async (request: CreateInboundWebhookEndpointRequest) => {
      const { endpoint, secret } = await createInboundWebhookEndpoint(request);
      onSecretIssued({ endpointId: endpoint.id, label: endpoint.label, secret });
      return endpoint;
    },
    onSuccess: invalidate,
  });

  const rotate = useMutation({
    gcTime: 0,
    mutationFn: async (id: string) => {
      const { endpoint, secret } = await rotateInboundWebhookEndpointSecret(id);
      onSecretIssued({ endpointId: endpoint.id, label: endpoint.label, secret });
      return endpoint;
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, request }: { id: string; request: UpdateInboundWebhookEndpointRequest }) =>
      updateInboundWebhookEndpoint(id, request),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: deleteInboundWebhookEndpoint,
    onSuccess: invalidate,
  });

  const clearPrevious = useMutation({
    mutationFn: clearInboundWebhookEndpointPreviousSecret,
    onSuccess: invalidate,
  });

  return { create, rotate, update, remove, clearPrevious };
}
