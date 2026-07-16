import { Body, Controller, Get, Post, Req, UseGuards, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { registerSchema, loginSchema } from '@geniusdebug/shared';
import { AuthService } from './auth.service';
import { JwtGuard, type AuthPrincipal } from './jwt.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Lets the login page show "Create your account" on a fresh install. */
  @Get('status')
  async status() {
    return { firstRun: await this.auth.isFirstRun() };
  }

  @Post('register')
  async register(@Body() body: unknown) {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.auth.register(parsed.data);
  }

  @Post('login')
  async login(@Body() body: unknown) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.auth.login(parsed.data);
  }

  @Get('me')
  @UseGuards(JwtGuard)
  async me(@Req() req: Request & { user?: AuthPrincipal }) {
    return req.user;
  }
}
