import {
  type ArgumentMetadata,
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
  HttpException,
  type PipeTransform,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';

/** Validasi body/param dengan skema zod. Pesan galat hanya menyebut nama field, bukan nilainya. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'invalid_input',
        fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }
}

/** Galat API dengan kode mesin yang stabil (dipakai aplikasi untuk menampilkan pesan). */
export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ statusCode: status, error: code, message, ...extra }, status);
  }
}

export const IS_PUBLIC = 'isPublic';
/** Endpoint tanpa login. Semua endpoint lain wajib token akses (guard global). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface AuthUser {
  id: string;
  sessionId: string;
  role: 'user' | 'super_admin';
  /** Token dari login panel admin (kata sandi + TOTP). Hanya token ini yang boleh membuka /v1/admin. */
  admin?: boolean;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new ApiError(401, 'unauthorized', 'Perlu login');
  return req.user;
});
