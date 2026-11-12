import { describe, expect, it } from 'vitest';
import { overlapRatio } from '../runs/dedup.js';
import { garminToImported, validGarminCallbackUrl } from './garmin.js';
import { assertAllowedUrl, ProviderHttp } from './provider-http.js';
import { stravaToImported, validStravaId } from './strava.js';

describe('impor: validasi dan pemetaan', () => {
  it('callbackURL Garmin hanya ke https://apis.garmin.com/wellness-api/rest/', () => {
    expect(validGarminCallbackUrl('https://apis.garmin.com/wellness-api/rest/activityDetails?token=a')).toContain('apis.garmin.com');
    for (const bad of [
      'http://apis.garmin.com/wellness-api/rest/x',
      'https://apis.garmin.com.evil.test/wellness-api/rest/x',
      'https://apis.garmin.com:444/wellness-api/rest/x',
      'https://a@apis.garmin.com/wellness-api/rest/x',
      'https://apis.garmin.com/other',
      'https://10.0.0.1/wellness-api/rest/x',
      42,
      'bukan url',
    ]) {
      expect(validGarminCallbackUrl(bad)).toBeNull();
    }
  });

  it('allowlist host ProviderHttp', () => {
    expect(() => assertAllowedUrl('https://www.strava.com/api/v3/athlete')).not.toThrow();
    for (const bad of ['http://www.strava.com/', 'https://localhost/', 'https://www.strava.com:8443/', 'https://x@www.strava.com/', 'https://strava.com.evil.test/']) {
      expect(() => assertAllowedUrl(bad)).toThrow();
    }
  });

  it('ProviderHttp tidak mengikuti redirect dan mengirim token di header, bukan URL', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = new ProviderHttp();
    (http as unknown as { fetchFn: typeof fetch }).fetchFn = (async (url: URL, init: RequestInit) => {
      seen.push({ url: url.toString(), init });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await http.request('https://www.strava.com/api/v3/athlete', { bearer: 'tok' })).toEqual({ ok: true });
    expect(seen[0]!.init.redirect).toBe('error');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(seen[0]!.url).not.toContain('tok');
    await expect(http.request('https://169.254.169.254/latest')).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('Garmin: detail aktivitas lari → rute relatif; bukan lari → null', () => {
    const run = garminToImported({
      userId: 'u',
      summaryId: '9-detail',
      activityId: 9,
      summary: { activityType: 'TRAIL_RUNNING', startTimeInSeconds: 1000, durationInSeconds: 600, distanceInMeters: 1500, activityName: 'Pagi' },
      samples: [
        { startTimeInSeconds: 1010, latitudeInDegree: -6.9, longitudeInDegree: 107.6 },
        { startTimeInSeconds: 1000, latitudeInDegree: -6.9001, longitudeInDegree: 107.6 },
        { startTimeInSeconds: 1020 },
      ],
    });
    expect(run).toMatchObject({ source: 'garmin', externalId: '9', title: 'Pagi', visibility: 'private' });
    expect(run!.segments[0]!.map((p) => p[2])).toEqual([0, 10]);
    expect(garminToImported({ activityType: 'CYCLING', startTimeInSeconds: 1, durationInSeconds: 10, activityId: 1 })).toBeNull();
    expect(garminToImported({ activityType: 'RUNNING', startTimeInSeconds: 1, durationInSeconds: 10 })).toBeNull();
  });

  it('Strava: selalu privat; stream GPS dipakai jika panjangnya cocok', () => {
    const a = { id: 5, sport_type: 'Run', start_date: '2026-11-01T00:00:00Z', elapsed_time: 100, distance: 300 };
    const run = stravaToImported(a, { latlng: { data: [[-6.9, 107.6], [-6.901, 107.6]] }, time: { data: [0, 50] } });
    expect(run).toMatchObject({ source: 'strava', externalId: '5', visibility: 'private' });
    expect(run!.segments[0]).toHaveLength(2);
    expect(stravaToImported(a, { latlng: { data: [[-6.9, 107.6]] }, time: { data: [0, 50] } })!.segments).toEqual([]);
    expect(stravaToImported({ ...a, sport_type: 'Ride' })).toBeNull();
    expect(validStravaId('12/../x')).toBeNull();
    expect(validStravaId(123)).toBe('123');
  });

  it('tumpang-tindih dihitung terhadap lari yang lebih pendek', () => {
    const d = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
    expect(overlapRatio({ start: d(0), end: d(30) }, { start: d(10), end: d(20) })).toBe(1);
    expect(overlapRatio({ start: d(0), end: d(30) }, { start: d(15), end: d(45) })).toBe(0.5);
    expect(overlapRatio({ start: d(0), end: d(10) }, { start: d(10), end: d(20) })).toBe(0);
  });
});
