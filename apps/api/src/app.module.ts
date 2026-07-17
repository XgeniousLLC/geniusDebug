import { Module, Controller, Get } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtGuard } from './auth/jwt.guard';
import { IssuesController } from './issues/issues.controller';
import { IssuesService } from './issues/issues.service';
import { ProjectsController } from './projects/projects.controller';
import { MiscController } from './misc/misc.controller';
import { AdminController } from './admin/admin.controller';
import { GithubController } from './github/github.controller';
import { GithubService } from './github/github.service';
import { AlertsController } from './alerts/alerts.controller';
import { MetricsController } from './metrics/metrics.controller';
import { IntegrationsController } from './integrations/integrations.controller';
import { DashboardController } from './dashboard/dashboard.controller';

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'api' };
  }
}

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-only-change-me-in-prod',
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    IssuesController,
    ProjectsController,
    MiscController,
    AdminController,
    GithubController,
    AlertsController,
    MetricsController,
    IntegrationsController,
    DashboardController,
  ],
  providers: [AuthService, IssuesService, JwtGuard, GithubService],
})
export class AppModule {}
