import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TokenService } from '../auth/token.service.js';

/**
 * Batas laju per pengguna untuk permintaan yang membawa token akses sah, per IP untuk sisanya
 * (login, daftar, OTP, dsb.). Pengguna seluler di Indonesia banyak yang berbagi IP lewat CGNAT,
 * sehingga batas per IP pada endpoint ber-login (kirim chat, status lari) akan menolak banyak orang
 * sekaligus. Token diverifikasi tanda tangannya dulu, jadi `sub` palsu tidak bisa dipakai untuk
 * menghabiskan kuota pengguna lain.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  @Inject(TokenService) private readonly tokens!: TokenService;

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const header = (req.headers as Record<string, string | undefined> | undefined)?.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) {
      try {
        return `user:${(await this.tokens.verifyAccess(token)).id}`;
      } catch {
        // Token tidak sah: jatuh ke batas per IP; AuthGuard akan menolak permintaannya.
      }
    }
    return super.getTracker(req);
  }
}
