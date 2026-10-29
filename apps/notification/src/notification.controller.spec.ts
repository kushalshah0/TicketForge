import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationController } from './notification.controller';
import { NOTIFICATION_POOL, NotificationService } from './notification.service';

describe('NotificationController', () => {
  let notificationController: NotificationController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [NotificationController],
      providers: [
        NotificationService,
        { provide: NOTIFICATION_POOL, useValue: { end: jest.fn() } },
      ],
    }).compile();

    notificationController = app.get<NotificationController>(
      NotificationController,
    );
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(notificationController.getHello()).toBe('Hello World!');
    });
  });
});
