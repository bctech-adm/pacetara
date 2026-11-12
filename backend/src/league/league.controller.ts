import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { LevelGuard, RequireLevel } from '../auth/level.guard.js';
import { type AuthUser, CurrentUser, ZodPipe } from '../common/http.js';
import { LeagueService } from './league.service.js';

const uuid = new ParseUUIDPipe();
// Kota dan bulan bukan data pribadi (sama dengan filter event #108).
const LeagueQuery = z.object({
  month: z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/, 'Format bulan YYYY-MM').optional(),
  city: z.string().trim().min(2).max(60).optional(),
});
const StatsQuery = z.object({
  period: z.enum(['week', 'month']).default('week'),
  count: z.coerce.number().int().min(1).max(52).default(12),
});

/** Liga antar komunitas (modul 2.6). Papan peringkat terlihat semua pengguna Level 1; pesertanya hanya komunitas Pro. */
@Controller('league')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class LeagueController {
  constructor(private readonly league: LeagueService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  leaderboard(@CurrentUser() u: AuthUser, @Query(new ZodPipe(LeagueQuery)) q: z.infer<typeof LeagueQuery>) {
    return this.league.leaderboard(u.id, q);
  }
}

/** Statistik komunitas (Komunitas Pro, admin). */
@Controller('communities/:id/stats')
@UseGuards(LevelGuard)
@RequireLevel(1)
export class CommunityStatsController {
  constructor(private readonly league: LeagueService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  stats(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Query(new ZodPipe(StatsQuery)) q: z.infer<typeof StatsQuery>) {
    return this.league.communityStats(u.id, id, q.period, Math.min(q.count, q.period === 'month' ? 24 : 52));
  }
}
