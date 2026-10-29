import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard, RolesGuard } from '@tf/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

describe('PaymentController', () => {
  let paymentController: PaymentController;
  let app: INestApplication<App>;
  let pay: jest.Mock<PaymentService['pay']>;
  const userId = '11111111-1111-4111-8111-111111111111';
  const paymentId = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    pay = jest
      .fn<PaymentService['pay']>()
      .mockResolvedValue({ paymentId, status: 'PENDING' });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        {
          provide: PaymentService,
          useValue: {
            getHello: () => 'Hello World!',
            getPaymentByBooking: jest.fn(),
            pay,
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context
            .switchToHttp()
            .getRequest<{ user?: { sub: string; role: 'customer' } }>().user = {
            sub: userId,
            role: 'customer',
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();
    paymentController = app.get<PaymentController>(PaymentController);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(paymentController.getHello()).toBe('Hello World!');
    });
  });

  it('accepts payment initiation with HTTP 202 and the authenticated owner', async () => {
    await request(app.getHttpServer())
      .post(`/payments/${paymentId}/pay`)
      .set('Idempotency-Key', 'pay-once')
      .send({ scenario: 'success' })
      .expect(202)
      .expect({ paymentId, status: 'PENDING' });

    expect(pay).toHaveBeenCalledWith(userId, paymentId, 'pay-once', {
      scenario: 'success',
    });
  });
});
