import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { CatalogService } from './catalog.service';

@Controller()
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('events')
  listPublished(@Query() query: unknown) {
    return this.catalogService.listPublished(query);
  }

  @Get('events/:id')
  getPublished(@Param('id') id: string) {
    return this.catalogService.getPublished(id);
  }

  @Post('events')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('organizer')
  createDraft(@CurrentUser() user: AuthenticatedUser, @Body() input: unknown) {
    return this.catalogService.createDraft(user.sub, input);
  }

  @Patch('events/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('organizer')
  updateEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.catalogService.updateEvent(user.sub, id, input);
  }

  @Post('events/:id/publish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('organizer')
  publishEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.catalogService.publishEvent(user.sub, id);
  }

  @Post('events/:id/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('organizer')
  cancelEvent(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.catalogService.cancelEvent(user.sub, id);
  }

  @Get('organizer/events')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('organizer')
  listOrganizerEvents(@CurrentUser() user: AuthenticatedUser) {
    return this.catalogService.listOrganizerEvents(user.sub);
  }
}
