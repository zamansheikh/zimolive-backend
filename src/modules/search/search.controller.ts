import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchService } from './search.service';

/**
 * Home-screen search bar — combined rooms + users lookup. Auth-gated so
 * the search index isn't open to scrapers / unauthenticated probes.
 */
@Controller({ path: 'search', version: '1' })
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  async search(
    @Query('q') q?: string,
    @Query('limit') limit?: number,
  ) {
    return this.svc.search(q ?? '', limit ?? 20);
  }
}
