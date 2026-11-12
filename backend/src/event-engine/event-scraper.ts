import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { ENV, type Env } from '../config/env.js';
import { PG_POOL } from '../core.module.js';
import { todayWib } from '../events/event-archive.js';
import { EventSubmissionsService } from './event-submissions.service.js';
import { ScrapeError, ScrapeHttp } from './scrape-http.js';
import { type EventSource, loadSources, PARSERS } from './sources.js';

export interface ScrapeStats {
  sourceId: string;
  pages: number;
  found: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/**
 * Scraping terjadwal (job worker `event-scrape`). Setiap sumber dibaca halaman demi halaman lewat
 * ScrapeHttp (robots.txt, jeda, anti-SSRF), diurai parsernya, lalu masuk antrean `event_submissions`.
 * Tidak ada yang langsung tayang. Log hanya berisi id sumber, jumlah, dan kode galat — bukan isi halaman.
 */
@Injectable()
export class EventScraper {
  private readonly logger = new Logger('EventScraper');
  readonly sources: EventSource[];

  constructor(
    @Inject(ENV) env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly http: ScrapeHttp,
    private readonly submissions: EventSubmissionsService,
  ) {
    this.sources = loadSources(env.EVENT_SCRAPE_SOURCES);
  }

  get enabled(): boolean {
    return this.sources.length > 0;
  }

  async runAll(): Promise<ScrapeStats[]> {
    const out: ScrapeStats[] = [];
    for (const s of this.sources) out.push(await this.runSource(s));
    return out;
  }

  async runSource(source: EventSource): Promise<ScrapeStats> {
    const stats: ScrapeStats = { sourceId: source.id, pages: 0, found: 0, created: 0, updated: 0, skipped: 0, errors: [] };
    const startedAt = new Date();
    const parser = PARSERS[source.parser]!;
    for (const url of source.urls) {
      let html: string;
      try {
        html = await this.http.get(url, source.allowedHosts);
      } catch (err) {
        stats.errors.push(err instanceof ScrapeError ? `${err.code}: ${err.message}` : 'galat tidak dikenal');
        continue;
      }
      stats.pages++;
      const items = parser(html, url, todayWib());
      stats.found += items.length;
      for (const item of items) {
        try {
          const r = await this.submissions.upsertScraped(source, item);
          if (r === 'created') stats.created++;
          else if (r === 'updated') stats.updated++;
        } catch {
          // Data melanggar batasan tabel (mis. nama terlalu panjang setelah normalisasi) — lewati satu event saja.
          stats.skipped++;
        }
      }
    }
    await this.pool.query(
      `INSERT INTO event_scrape_runs (source_id, started_at, finished_at, pages, found, created, updated, skipped, errors)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_id) DO UPDATE SET started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at, pages = EXCLUDED.pages,
         found = EXCLUDED.found, created = EXCLUDED.created, updated = EXCLUDED.updated, skipped = EXCLUDED.skipped, errors = EXCLUDED.errors`,
      [source.id, startedAt, stats.pages, stats.found, stats.created, stats.updated, stats.skipped, stats.errors.slice(0, 20).map((e) => e.slice(0, 200))],
    );
    this.logger.log(
      `Sumber ${source.id}: ${stats.pages}/${source.urls.length} halaman, ${stats.found} event, ${stats.created} baru, ${stats.updated} diperbarui, ${stats.errors.length} galat`,
    );
    return stats;
  }

  /** Untuk panel: sumber yang dikonfigurasi + putaran terakhir. */
  async status() {
    const { rows } = await this.pool.query<{
      source_id: string;
      started_at: Date;
      finished_at: Date | null;
      pages: number;
      found: number;
      created: number;
      updated: number;
      skipped: number;
      errors: string[];
    }>('SELECT * FROM event_scrape_runs');
    const runs = new Map(rows.map((r) => [r.source_id, r]));
    return {
      userAgent: this.http.userAgent,
      sources: this.sources.map((s) => {
        const r = runs.get(s.id);
        return {
          id: s.id,
          name: s.name,
          urls: s.urls,
          parser: s.parser,
          lastRun: r
            ? {
                startedAt: r.started_at.toISOString(),
                finishedAt: r.finished_at?.toISOString() ?? null,
                pages: r.pages,
                found: r.found,
                created: r.created,
                updated: r.updated,
                skipped: r.skipped,
                errors: r.errors,
              }
            : null,
        };
      }),
    };
  }
}
