import { describe, expect, it, vi } from 'vitest';
import { rejectInsecure } from './reject-insecure.js';

const run = (nodeEnv: 'production' | 'development', secure: boolean, path = '/v1/me') => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  rejectInsecure({ NODE_ENV: nodeEnv })({ secure, path } as never, res as never, next);
  return { res, next };
};

describe('rejectInsecure', () => {
  it('menolak HTTP biasa di produksi', () => {
    const { res, next } = run('production', false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
  it('meneruskan HTTPS di produksi', () => expect(run('production', true).next).toHaveBeenCalled());
  it('meneruskan healthcheck internal', () => expect(run('production', false, '/health').next).toHaveBeenCalled());
  it('tidak memblokir saat development', () => expect(run('development', false).next).toHaveBeenCalled());
});
