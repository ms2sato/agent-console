import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InboundWebhookEndpoint, UpdateInboundWebhookEndpointRequest } from '@agent-console/shared';
import {
  clearInboundWebhookEndpointPreviousSecret,
  createInboundWebhookEndpoint,
  deleteInboundWebhookEndpoint,
  fetchInboundWebhookEndpoint,
  fetchInboundWebhookEndpoints,
  fetchSystemHealth,
  rotateInboundWebhookEndpointSecret,
  updateInboundWebhookEndpoint,
} from '../../../lib/api';
import { inboundWebhookEndpointKeys, systemKeys } from '../../../lib/query-keys';

/** A freshly generated signing secret. It exists only in the caller's state. */
export interface IssuedSecret {
  endpointId: string;
  label: string;
  secret: string;
}

/**
 * Hands over an entered secret exactly once. The form builds it around a
 * closure that forgets the value after the first call, so the secret never
 * sits in a mutation variable (TanStack keeps `variables` in mutation state).
 */
export type TakeSecret = () => string | undefined;

export interface CreateEndpointVariables {
  label: string;
  instructionText: string;
  takeSecret?: TakeSecret;
}

export interface RotateSecretVariables {
  endpoint: Pick<InboundWebhookEndpoint, 'id' | 'label'>;
  takeSecret?: TakeSecret;
}

/** What a create or rotate leaves behind: never a secret. */
export interface SecretIssueOutcome {
  endpoint: InboundWebhookEndpoint;
  secretSource: 'generated' | 'entered';
}

export function useInboundWebhookEndpointsQuery(repositoryId: string) {
  return useQuery({
    queryKey: inboundWebhookEndpointKeys.all(repositoryId),
    queryFn: () => fetchInboundWebhookEndpoints(repositoryId),
  });
}

export function useUpdateInboundWebhookEndpoint(repositoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: UpdateInboundWebhookEndpointRequest }) =>
      updateInboundWebhookEndpoint(repositoryId, id, request),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: inboundWebhookEndpointKeys.detail(repositoryId, id) });
      return queryClient.invalidateQueries({ queryKey: inboundWebhookEndpointKeys.all(repositoryId) });
    },
  });
}

export function useInboundWebhookEndpointQuery(repositoryId: string, endpointId: string) {
  return useQuery({
    queryKey: inboundWebhookEndpointKeys.detail(repositoryId, endpointId),
    queryFn: () => fetchInboundWebhookEndpoint(repositoryId, endpointId),
  });
}

/**
 * The internet-facing origin the receive URL is built on, or null when the
 * server setting is unset. `isLoaded` lets the UI avoid flashing the "unset"
 * hint while the health read is still in flight.
 */
export function useInternetOrigin(): { internetOrigin: string | null; isLoaded: boolean } {
  const { data } = useQuery({ queryKey: systemKeys.health(), queryFn: fetchSystemHealth });
  return { internetOrigin: data?.internetOrigin ?? null, isLoaded: data !== undefined };
}

/**
 * Mutations for inbound webhook endpoints.
 *
 * A generated secret is handed to `onSecretIssued` inside the mutation
 * function; an entered one is read from `takeSecret` there, used for the
 * request and not kept. What the mutation returns carries no secret, mutations
 * use `gcTime: 0`, and `createEndpoint` / `rotateSecret` call `reset()` once
 * the request settles, so no secret outlives the call in any cache.
 */
export function useInboundWebhookEndpointMutations(
  repositoryId: string,
  onSecretIssued: (issued: IssuedSecret) => void,
) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: inboundWebhookEndpointKeys.all(repositoryId) });

  const create = useMutation({
    gcTime: 0,
    mutationFn: async ({ label, instructionText, takeSecret }: CreateEndpointVariables): Promise<SecretIssueOutcome> => {
      const result = await createInboundWebhookEndpoint(repositoryId, {
        label,
        instructionText,
        secret: takeSecret?.(),
      });
      if (result.secretSource === 'generated') {
        onSecretIssued({ endpointId: result.endpoint.id, label: result.endpoint.label, secret: result.secret });
      }
      return { endpoint: result.endpoint, secretSource: result.secretSource };
    },
    onSuccess: invalidate,
  });

  const rotate = useMutation({
    gcTime: 0,
    mutationFn: async ({ endpoint, takeSecret }: RotateSecretVariables): Promise<SecretIssueOutcome> => {
      const result = await rotateInboundWebhookEndpointSecret(repositoryId, endpoint.id, takeSecret?.());
      if (result.secretSource === 'generated') {
        onSecretIssued({ endpointId: result.endpoint.id, label: result.endpoint.label, secret: result.secret });
      }
      return { endpoint: result.endpoint, secretSource: result.secretSource };
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteInboundWebhookEndpoint(repositoryId, id),
    onSuccess: invalidate,
  });

  const clearPrevious = useMutation({
    mutationFn: (id: string) => clearInboundWebhookEndpointPreviousSecret(repositoryId, id),
    onSuccess: invalidate,
  });

  const createEndpoint = async (variables: CreateEndpointVariables) => {
    try {
      return await create.mutateAsync(variables);
    } finally {
      create.reset();
    }
  };

  const rotateSecret = async (variables: RotateSecretVariables) => {
    try {
      return await rotate.mutateAsync(variables);
    } finally {
      rotate.reset();
    }
  };

  return { create, rotate, remove, clearPrevious, createEndpoint, rotateSecret };
}
