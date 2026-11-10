import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, type AuthedRequest, IS_PUBLIC } from '../common/http.js';
import { TokenService } from './token.service.js';

/** Guard global: setiap endpoint wajib `Authorization: Bearer <token akses>` kecuali ditandai @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true; // WebSocket memakai autentikasi sendiri (modul 1.5/1.6)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new ApiError(401, 'unauthorized', 'Perlu login');
    req.user = await this.tokens.verifyAccess(token);
    return true;
  }
}
