import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface AuthPrincipal {
  userId: string;
  orgId: string;
  role: 'admin' | 'member';
  email: string;
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('missing token');
    try {
      const payload = this.jwt.verify<AuthPrincipal>(header.slice(7));
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('invalid token');
    }
  }
}
