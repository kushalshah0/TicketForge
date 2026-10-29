import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  type AuthenticatedUser,
} from '@tf/common';
import { BookingService } from './booking.service';

@Controller()
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get('events/:id/availability')
  getAvailability(@Param('id') eventId: string) {
    return this.bookingService.getAvailability(eventId);
  }

  @Post('bookings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  createHold(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: unknown,
  ) {
    return this.bookingService.createHold(user.sub, idempotencyKey, input);
  }

  @Get('bookings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  listBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.bookingService.listBookings(user.sub, limit, offset);
  }

  @Get('bookings/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  getBooking(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bookingService.getBooking(user.sub, id);
  }

  @Post('bookings/:id/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  cancelBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookingService.cancelBooking(user.sub, id);
  }

  @Get('tickets')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  listTickets(@CurrentUser() user: AuthenticatedUser) {
    return this.bookingService.listTickets(user.sub);
  }

  @Get('tickets/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('customer')
  getTicket(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bookingService.getTicket(user.sub, id);
  }

  @Post('checkin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('organizer')
  checkIn(@CurrentUser() user: AuthenticatedUser, @Body() input: unknown) {
    return this.bookingService.checkIn(user.sub, input);
  }
}
