import { describe, expect, it } from '@jest/globals';
import { canAccessRole } from './roles';

describe('role-based page access', () => {
  it('does not allow a customer into organizer pages', () => {
    expect(
      canAccessRole(
        {
          accessToken: 'token',
          user: {
            id: 'customer-1',
            email: 'customer@example.test',
            displayName: 'Customer',
            role: 'customer',
          },
        },
        'organizer',
      ),
    ).toBe(false);
  });

  it('allows an organizer into organizer pages', () => {
    expect(
      canAccessRole(
        {
          accessToken: 'token',
          user: {
            id: 'organizer-1',
            email: 'organizer@example.test',
            displayName: 'Organizer',
            role: 'organizer',
          },
        },
        'organizer',
      ),
    ).toBe(true);
  });
});
