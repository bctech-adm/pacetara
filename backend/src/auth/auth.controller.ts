import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { type AuthUser, CurrentUser, Public, ZodPipe } from '../common/http.js';
import { ENV, type Env } from '../config/env.js';
import { garminEnabled, stravaEnabled } from '../imports/config.js';
import { normalizePhoneId } from '../crypto/field-crypto.js';
import { AuthService } from './auth.service.js';
import { GoogleVerifier, Mailer } from './channels.js';
import { CODE_LENGTH } from './codes.service.js';
import { PASSWORD_MAX, PASSWORD_MIN } from './password.js';

const email = z.string().trim().toLowerCase().email('Email tidak valid').max(254);
const password = z
  .string()
  .min(PASSWORD_MIN, `Kata sandi minimal ${PASSWORD_MIN} karakter`)
  .max(PASSWORD_MAX, `Kata sandi maksimal ${PASSWORD_MAX} karakter`);
const displayName = z.string().trim().min(1, 'Nama wajib diisi').max(60, 'Nama maksimal 60 karakter');
const device = z.string().trim().max(80).optional();
const code = z.string().trim().regex(new RegExp(`^\\d{${CODE_LENGTH}}$`), `Kode berisi ${CODE_LENGTH} angka`);
const phone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      return normalizePhoneId(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Nomor HP Indonesia tidak valid' });
      return z.NEVER;
    }
  });

const RegisterBody = z.object({
  email,
  password,
  displayName,
  acceptPrivacy: z.literal(true, { message: 'Kebijakan privasi wajib disetujui' }),
  privacyVersion: z.string().min(1),
  device,
});
const LoginBody = z.object({ email, password: z.string().min(1).max(PASSWORD_MAX), device });
const GoogleBody = z.object({
  idToken: z.string().min(20).max(4096),
  acceptPrivacy: z.literal(true).optional(),
  privacyVersion: z.string().min(1).optional(),
  device,
});
const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const LogoutBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });
const CodeBody = z.object({ code });
const PhoneBody = z.object({ phone });
const ForgotBody = z.object({ email });
const ResetBody = z.object({ email, code, newPassword: password });
const ChangePasswordBody = z.object({ currentPassword: z.string().max(PASSWORD_MAX).optional(), newPassword: password });

// Batas laju per IP (di atas batas Traefik). Kode OTP juga dibatasi per akun di CodesService.
const STRICT = { default: { limit: 10, ttl: 60_000 } };
const OTP = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
    private readonly googleVerifier: GoogleVerifier,
  ) {}

  /** Info yang dibutuhkan layar daftar: versi kebijakan privasi dan metode login yang aktif. */
  @Public()
  @Get('config')
  config() {
    return {
      privacyVersion: this.env.PRIVACY_POLICY_VERSION,
      privacyUrl: this.env.PRIVACY_POLICY_URL,
      googleEnabled: this.googleVerifier.enabled,
      emailEnabled: this.mailer.enabled,
      // Modul 2.3: aplikasi menyembunyikan tombol penyedia yang belum dikonfigurasi.
      imports: { garmin: garminEnabled(this.env), strava: stravaEnabled(this.env) },
    };
  }

  @Public()
  @Throttle(STRICT)
  @Post('register')
  register(@Body(new ZodPipe(RegisterBody)) b: z.infer<typeof RegisterBody>) {
    return this.auth.register(b);
  }

  @Public()
  @Throttle(STRICT)
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginBody)) b: z.infer<typeof LoginBody>) {
    return this.auth.login(b);
  }

  @Public()
  @Throttle(STRICT)
  @Post('google')
  @HttpCode(200)
  loginGoogle(@Body(new ZodPipe(GoogleBody)) b: z.infer<typeof GoogleBody>) {
    return this.auth.loginWithGoogle({
      idToken: b.idToken,
      privacyVersion: b.acceptPrivacy ? b.privacyVersion : undefined,
      device: b.device,
    });
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(RefreshBody)) b: z.infer<typeof RefreshBody>) {
    return this.auth.refresh(b.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() u: AuthUser, @Body(new ZodPipe(LogoutBody)) b: z.infer<typeof LogoutBody>) {
    await this.auth.logout(u.id, b.refreshToken, u.sessionId);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentUser() u: AuthUser) {
    await this.auth.logoutAll(u.id);
  }

  @Throttle(OTP)
  @Post('email/send-code')
  @HttpCode(200)
  sendEmailCode(@CurrentUser() u: AuthUser) {
    return this.auth.sendEmailCode(u.id);
  }

  @Throttle(STRICT)
  @Post('email/verify')
  @HttpCode(200)
  verifyEmail(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.auth.verifyEmail(u.id, b.code);
  }

  @Throttle(OTP)
  @Post('phone/send-code')
  @HttpCode(200)
  sendPhoneCode(@CurrentUser() u: AuthUser, @Body(new ZodPipe(PhoneBody)) b: z.infer<typeof PhoneBody>) {
    return this.auth.sendPhoneCode(u.id, b.phone);
  }

  @Throttle(STRICT)
  @Post('phone/verify')
  @HttpCode(200)
  verifyPhone(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.auth.verifyPhone(u.id, b.code);
  }

  @Public()
  @Throttle(OTP)
  @Post('password/forgot')
  @HttpCode(204)
  async forgot(@Body(new ZodPipe(ForgotBody)) b: z.infer<typeof ForgotBody>) {
    await this.auth.forgotPassword(b.email);
  }

  @Public()
  @Throttle(STRICT)
  @Post('password/reset')
  @HttpCode(204)
  async reset(@Body(new ZodPipe(ResetBody)) b: z.infer<typeof ResetBody>) {
    await this.auth.resetPassword(b);
  }

  @Throttle(STRICT)
  @Post('password/change')
  @HttpCode(204)
  async change(@CurrentUser() u: AuthUser, @Body(new ZodPipe(ChangePasswordBody)) b: z.infer<typeof ChangePasswordBody>) {
    await this.auth.changePassword(u.id, b.currentPassword, b.newPassword, u.sessionId);
  }
}
