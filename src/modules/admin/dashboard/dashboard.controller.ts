import { Controller, Get } from '@nestjs/common';

import { AdminOnly } from '../admin-auth/decorators/admin-only.decorator';
import { DashboardService } from './dashboard.service';

/**
 * Admin dashboard overview — aggregate KPIs + daily time-series + breakdowns
 * for the landing page charts. Any authenticated admin may view it.
 */
@Controller({ path: 'admin/dashboard', version: '1' })
@AdminOnly()
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('overview')
  async overview() {
    return this.svc.overview();
  }
}
