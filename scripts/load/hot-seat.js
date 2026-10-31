import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const fixtures = new SharedArray('readiness', () => [
  JSON.parse(open('/fixtures/load.json')),
])[0];
const holds = new Counter('holds_created');
const paid = new Counter('payments_accepted');
const holdLatency = new Trend('hold_latency', true);
export const options = {
  scenarios: {
    hot_seat: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    holds_created: ['count==100'],
    payments_accepted: ['count==100'],
    hold_latency: ['p(95)<2000'],
    http_req_failed: ['rate==0'],
  },
};
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 404, 409));

export default function () {
  const headers = {
    authorization: `Bearer ${fixtures.tokens[__VU - 1]}`,
    'content-type': 'application/json',
    'Idempotency-Key': `load-hold-${__VU}`,
  };
  const hold = http.post(
    'http://gateway:3000/api/bookings',
    JSON.stringify({
      eventId: fixtures.eventId,
      seatIds: [fixtures.seats[(__VU - 1) % 100]],
    }),
    { headers, timeout: '20s' },
  );
  holdLatency.add(hold.timings.duration);
  if (
    !check(hold, {
      'hold accepted or conflict': (r) => r.status === 201 || r.status === 409,
    })
  )
    return;
  if (hold.status === 409) return;
  holds.add(1);
  const bookingId = hold.json('bookingId');
  let payment;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = http.get(
      `http://gateway:3000/api/payments/by-booking/${bookingId}`,
      { headers, timeout: '10s' },
    );
    if (result.status === 200) {
      payment = result.json();
      break;
    }
    if (
      !check(result, { 'payment lookup pending only': (r) => r.status === 404 })
    )
      return;
    sleep(0.25);
  }
  if (!check(payment, { 'payment created': (p) => Boolean(p?.id) })) return;
  const result = http.post(
    `http://gateway:3000/api/payments/${payment.id}/pay`,
    JSON.stringify({ scenario: 'success' }),
    {
      headers: { ...headers, 'Idempotency-Key': `load-pay-${__VU}` },
      timeout: '20s',
    },
  );
  if (check(result, { 'payment accepted': (r) => r.status === 202 }))
    paid.add(1);
}
