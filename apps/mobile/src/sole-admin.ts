import { useAuth } from './auth';
import { useQuery } from './ui';

/** True when single-admin mode lets this Super Admin approve their own requests (the API enforces it too). */
export function useSoleAdmin(): boolean {
  const { me } = useAuth();
  const q = useQuery<{ soleAdminApprovals: boolean }>(`{ soleAdminApprovals }`, undefined, undefined, me?.role !== 'SUPER_ADMIN');
  return !!q.data?.soleAdminApprovals;
}
