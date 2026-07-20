import { Module, Controller, Get } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtGuard } from './auth/jwt.guard';
import { IssuesController, PublicIssueController } from './issues/issues.controller';
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
import { SuggestController } from './suggest/suggest.controller';
import { RealtimeController } from './realtime/realtime.controller';
import { SuggestService } from './suggest/suggest.service';
import { RootController } from './http-pages';

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
    RootController,
    AuthController,
    IssuesController,
    PublicIssueController,
    ProjectsController,
    MiscController,
    AdminController,
    GithubController,
    AlertsController,
    MetricsController,
    IntegrationsController,
    DashboardController,
    SuggestController,
    RealtimeController,
  ],
  providers: [AuthService, IssuesService, JwtGuard, GithubService, SuggestService],
})
export class AppModule {}
