import { Module } from '@nestjs/common';
import { EnvelopeController } from './envelope.controller';
import { DsnService } from './dsn.service';
import { RateLimitService } from './ratelimit.service';
import { EnvelopeService } from './envelope.service';

@Module({
  controllers: [EnvelopeController],
  providers: [DsnService, RateLimitService, EnvelopeService],
})
export class AppModule {}
