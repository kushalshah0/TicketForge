import {
  catalogLayoutAndTiersSchema,
  createCatalogEventSchema,
} from '../../apps/catalog/src/catalog.schemas';
import { ApiError, apiRequest } from './api';
import type { CatalogEvent } from './events';

export interface OrganizerEvent extends CatalogEvent {
  status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
}

export interface CheckInResult {
  id: string;
  eventId: string;
  seatId: string;
  status: 'USED';
  usedAt: string;
}

export function listOrganizerEvents(): Promise<OrganizerEvent[]> {
  return apiRequest<OrganizerEvent[]>('/api/organizer/events');
}

export async function createOrganizerEvent(
  input: unknown,
): Promise<OrganizerEvent> {
  const event = createCatalogEventSchema.parse(input);
  catalogLayoutAndTiersSchema.parse({
    layout: event.layout,
    tiers: event.tiers,
  });
  return apiRequest<OrganizerEvent>('/api/events', {
    method: 'POST',
    body: event,
  });
}

export function changeEventStatus(
  id: string,
  action: 'publish' | 'cancel',
): Promise<OrganizerEvent> {
  return apiRequest<OrganizerEvent>(
    `/api/events/${encodeURIComponent(id)}/${action}`,
    { method: 'POST' },
  );
}

export function checkInTicket(token: string): Promise<CheckInResult> {
  return apiRequest<CheckInResult>('/api/checkin', {
    method: 'POST',
    body: { token: token.trim() },
  });
}

export function checkInErrorMessage(error: Error): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'TICKET_ALREADY_USED':
        return 'Already used: this ticket has already been checked in.';
      case 'TICKET_VOID':
        return 'Void ticket: this ticket is no longer valid for entry.';
      case 'TICKET_INVALID':
        return 'Invalid ticket: the QR token could not be verified.';
      case 'EVENT_FORBIDDEN':
        return 'This ticket belongs to another organizer.';
    }
  }
  return error.message;
}
