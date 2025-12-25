import { useQuery } from '@tanstack/react-query';
import { fetchRepositories } from '../lib/api';

/**
 * Hook for fetching repositories list with TanStack Query.
 * Returns loading, error state and refetch function along with data.
 */
export function useRepositories() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['repositories'],
    queryFn: fetchRepositories,
  });

  return {
    repositories: data?.repositories ?? [],
    isLoading,
    error,
    refetch,
  };
}
