import { Injectable } from '@nestjs/common';

type DownstreamName =
  'auth' | 'catalog' | 'booking' | 'payment' | 'notification';
type ServiceStatus = 'up' | 'down';

export interface GatewayHealthReport {
  status: 'ok' | 'degraded';
  gateway: { status: 'up' };
  downstreams: Record<DownstreamName, ServiceStatus>;
}

const downstreamOrigins: Record<DownstreamName, string> = {
  auth: process.env.AUTH_SERVICE_URL ?? 'http://127.0.0.1:3001',
  catalog: process.env.CATALOG_SERVICE_URL ?? 'http://127.0.0.1:3002',
  booking: process.env.BOOKING_SERVICE_URL ?? 'http://127.0.0.1:3003',
  payment: process.env.PAYMENT_SERVICE_URL ?? 'http://127.0.0.1:3004',
  notification: process.env.NOTIFICATION_SERVICE_URL ?? 'http://127.0.0.1:3005',
};

@Injectable()
export class GatewayHealthService {
  private cached?: { expiresAt: number; report: GatewayHealthReport };

  async getReport(): Promise<GatewayHealthReport> {
    if (this.cached && Date.now() < this.cached.expiresAt)
      return this.cached.report;

    const entries = await Promise.all(
      Object.entries(downstreamOrigins).map(async ([name, origin]) => {
        let status: ServiceStatus = 'down';
        try {
          const response = await fetch(new URL('/health/ready', origin), {
            signal: AbortSignal.timeout(1_000),
          });
          if (response.ok) status = 'up';
        } catch {}
        return [name, status] as const;
      }),
    );
    const downstreams = Object.fromEntries(entries) as Record<
      DownstreamName,
      ServiceStatus
    >;
    const report: GatewayHealthReport = {
      status: Object.values(downstreams).every((status) => status === 'up')
        ? 'ok'
        : 'degraded',
      gateway: { status: 'up' },
      downstreams,
    };
    this.cached = { expiresAt: Date.now() + 5_000, report };
    return report;
  }
}
