import http from 'k6/http';
import { check } from 'k6';

const fixture = JSON.parse(open('/fixtures/load.json'));
export const options = {
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2000'],
    dropped_iterations: ['count==0'],
  },
};
export default function () {
  const results = http.batch([
    ['GET', 'http://gateway:3000/api/events'],
    ['GET', `http://gateway:3000/api/events/${fixture.eventId}/availability`],
  ]);
  for (const response of results)
    check(response, { 'browse returns 200': (r) => r.status === 200 });
}
