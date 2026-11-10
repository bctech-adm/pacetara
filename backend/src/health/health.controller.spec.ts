import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

const make = (dbOk: boolean, redisOk: boolean) => {
  const pool = {
    query: vi.fn(() => (dbOk ? Promise.resolve({}) : Promise.reject(new Error('conn refused 10.0.0.5')))),
  };
  const redis = { ping: vi.fn(() => (redisOk ? Promise.resolve('PONG') : Promise.reject(new Error('x')))) };
  return new HealthController(pool as never, redis as never);
};

describe('HealthController', () => {
  it('ok jika database dan redis sehat', async () => {
    await expect(make(true, true).ready()).resolves.toEqual({ status: 'ok', database: 'ok', redis: 'ok' });
  });

  it('503 tanpa detail galat jika database mati', async () => {
    const err = await make(false, true)
      .ready()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const body = (err as ServiceUnavailableException).getResponse();
    expect(body).toEqual({ status: 'degraded', database: 'down', redis: 'ok' });
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });
});
