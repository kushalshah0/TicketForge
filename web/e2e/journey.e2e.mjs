import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('organizer publishes, competing seat holds resolve, customer pays, ticket checks in', async ({ browser, baseURL }) => {
  const runId = randomUUID();
  const title = `Browser acceptance ${runId}`;
  const password = `Acceptance-${randomUUID()}`;
  const organizer = await browser.newContext({ baseURL });
  const customer = await browser.newContext({ baseURL });
  const organizerPage = await organizer.newPage();
  const customerPage = await customer.newPage();
  const path = new URL(baseURL).pathname.replace(/\/$/, '');
  const url = (route) => `${path}${route}`;
  const errors = [];
  organizerPage.on('pageerror', (error) => errors.push(error.message));
  customerPage.on('pageerror', (error) => errors.push(error.message));
  let eventId;
  let ticketPage;

  async function register(page, role) {
    await page.goto(url('/register'));
    await page.getByLabel('Name', { exact: true }).fill(`Browser ${role}`);
    await page.getByLabel('Email', { exact: true }).fill(`${role}-${runId}@example.test`);
    await page.getByLabel(/^Password/).fill(password);
    await page.getByLabel('Account type').selectOption(role);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  }

  try {
    await register(organizerPage, 'organizer');
    await organizerPage.getByRole('link', { name: 'Organizer', exact: true }).click();
    await organizerPage.getByLabel('Title', { exact: true }).fill(title);
    await organizerPage.getByLabel('Venue', { exact: true }).fill('Acceptance Hall');
    await organizerPage.getByLabel('City', { exact: true }).fill('Kathmandu');
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
    await organizerPage.getByLabel('Starts at (your local time)').fill(future);
    await organizerPage.getByLabel('Name', { exact: true }).fill('Main');
    await organizerPage.getByLabel('Tier name').fill('Standard');
    await organizerPage.getByLabel('Seats per row (1-40)').fill('4');
    await organizerPage.getByLabel('Price in minor units').fill('1200');
    await organizerPage.getByRole('button', { name: 'Create draft', exact: true }).click();
    const card = organizerPage.getByRole('listitem').filter({ has: organizerPage.getByRole('heading', { name: title, exact: true }) });
    await card.getByRole('button', { name: 'Publish', exact: true }).click();
    await card.getByRole('button', { name: 'Confirm publish', exact: true }).click();
    const eventHref = await card.getByRole('link', { name: 'Public event' }).getAttribute('href');
    eventId = eventHref.split('/').at(-1);

    await register(customerPage, 'customer');
    await customerPage.getByRole('link', { name: 'Events', exact: true }).click();
    await customerPage.getByLabel('Search events').fill(title);
    await customerPage.getByLabel('City', { exact: true }).fill('Kathmandu');
    await customerPage.getByRole('button', { name: 'Search', exact: true }).click();
    await customerPage.getByRole('heading', { name: title, exact: true }).click();
    await expect(customerPage.getByRole('button', { name: /, Available$/ }).first()).toBeVisible();

    const contender = await customer.newPage();
    contender.on('pageerror', (error) => errors.push(error.message));
    await contender.goto(url(`/events/${eventId}`));
    const seat = customerPage.getByRole('button', { name: /, Available$/ }).first();
    const seatName = await seat.getAttribute('aria-label');
    await seat.click();
    await contender.getByRole('button', { name: seatName, exact: true }).click();
    const holdResponses = [
      customerPage.waitForResponse((response) => response.url().endsWith('/api/bookings') && response.request().method() === 'POST'),
      contender.waitForResponse((response) => response.url().endsWith('/api/bookings') && response.request().method() === 'POST'),
    ];
    await Promise.all([
      customerPage.getByRole('button', { name: 'Reserve seats', exact: true }).click(),
      contender.getByRole('button', { name: 'Reserve seats', exact: true }).click(),
    ]);
    const responses = await Promise.all(holdResponses);
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409]);
    const winner = responses[0].status() === 201 ? customerPage : contender;
    ticketPage = winner;
    const loser = winner === customerPage ? contender : customerPage;
    await expect(loser.getByText('Those seats were just reserved by someone else. Availability has been refreshed.')).toBeVisible();
    await winner.getByRole('link', { name: 'Continue to checkout' }).click();
    await expect(winner.getByRole('timer')).toBeVisible();
    await winner.reload();
    await expect(winner.getByRole('timer')).toBeVisible();
    await expect(winner.getByRole('button', { name: 'Pay now', exact: true })).toBeEnabled();
    await winner.getByRole('button', { name: 'Pay now', exact: true }).click();
    await expect(winner.getByText('Your booking is confirmed.', { exact: true })).toBeVisible();
    await winner.getByRole('link', { name: 'View my tickets' }).click();
    await expect(winner.getByRole('img', { name: 'Ticket QR code for organizer check-in' })).toBeVisible();
    // The QR token is fetched via the same authenticated owner API used by the ticket screen.
    const tickets = await winner.evaluate(async () => {
      const session = await fetch('/api/auth/refresh', {
        method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'TicketForge' },
      });
      if (!session.ok) throw new Error(`Ticket session failed (${session.status})`);
      const { accessToken } = await session.json();
      const response = await fetch('/api/tickets', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error(`Ticket lookup failed (${response.status})`);
      return response.json();
    });
    const ticket = tickets.find((item) => item.eventId === eventId);
    expect(ticket?.qrToken).toBeTruthy();
    await organizerPage.getByRole('link', { name: 'Check in a ticket' }).click();
    await organizerPage.getByLabel('Ticket token', { exact: true }).fill(ticket.qrToken);
    await organizerPage.getByRole('button', { name: 'Check in ticket', exact: true }).click();
    await expect(organizerPage.getByText(`Checked in successfully. Seat: ${ticket.seatId}`, { exact: true })).toBeVisible();
    await organizerPage.getByRole('button', { name: 'Check in ticket', exact: true }).click();
    await expect(organizerPage.getByText('Already used: this ticket has already been checked in.', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    try {
      if (eventId) {
        await organizerPage.goto(url('/organizer/events'));
        const card = organizerPage.getByRole('listitem').filter({ has: organizerPage.getByRole('heading', { name: title, exact: true }) });
        await card.getByRole('button', { name: 'Cancel event', exact: true }).click();
        await card.getByRole('button', { name: 'Confirm cancel', exact: true }).click();
        await expect(card.getByText('CANCELLED', { exact: true })).toBeVisible();
        if (ticketPage) {
          await ticketPage.goto(url('/tickets'));
          await expect(ticketPage.getByText('Status: VOID', { exact: true })).toBeVisible();
          await expect(ticketPage.getByRole('img', { name: 'Ticket QR code for organizer check-in' })).toHaveCount(0);
        }
      }
    } finally {
      await Promise.all([organizer.close(), customer.close()]);
    }
  }
});
