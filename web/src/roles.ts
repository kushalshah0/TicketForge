import type { AuthSession } from './api';

export function canAccessRole(
  session: AuthSession | null,
  role: AuthSession['user']['role'],
): boolean {
  return session?.user.role === role;
}
