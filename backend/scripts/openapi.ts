/**
 * Spesifikasi OpenAPI 3 minimal dari metadata controller Nest (tanpa menjalankan aplikasi atau database), untuk
 * pemindaian dinamis OWASP ZAP di CI (`zap-api-scan`). Hanya jalur, metode, parameter path, dan skema keamanan;
 * badan permintaan tidak dideskripsikan (validasi tetap di server dengan Zod).
 *
 *   node dist/scripts/openapi.js [berkas-keluaran] [server-url]
 *
 * Endpoint yang mengakhiri sesi pemindai atau menghapus akunnya dikecualikan agar pemindaian tetap terautentikasi.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { AppModule } from '../src/app.module.js';

const EXCLUDE = [/^\/v1\/auth\/logout/, /^\/v1\/me\/delete$/, /^\/v1\/auth\/sessions/, /^\/v1\/admin\/auth\/logout/];
const PUBLIC_PREFIX = 'v1';
const UNPREFIXED = new Set(['health', 'health/live']);

type Op = { operationId: string; tags: string[]; parameters?: object[]; responses: Record<string, object>; security?: object[] };

function join(...parts: string[]): string {
  return `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
}

export function buildSpec(serverUrl: string) {
  const controllers = (Reflect.getMetadata('controllers', AppModule) as (new (...a: never[]) => unknown)[] | undefined) ?? [];
  const paths: Record<string, Record<string, Op>> = {};
  for (const ctrl of controllers) {
    const base = ([] as string[]).concat((Reflect.getMetadata(PATH_METADATA, ctrl) as string | string[] | undefined) ?? '')[0] ?? '';
    const isPublicCtrl = Boolean(Reflect.getMetadata('isPublic', ctrl));
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (method === undefined || sub === undefined) continue;
      for (const s of ([] as string[]).concat(sub)) {
        const raw = join(base, s);
        const full = UNPREFIXED.has(raw.slice(1)) ? raw : join(PUBLIC_PREFIX, raw);
        if (EXCLUDE.some((r) => r.test(full))) continue;
        const params = [...full.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
        const oaPath = full.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        const verb = RequestMethod[method]!.toLowerCase();
        if (verb === 'all' || verb === 'options' || verb === 'head') continue;
        const isPublic = isPublicCtrl || Boolean(Reflect.getMetadata('isPublic', handler));
        paths[oaPath] ??= {};
        paths[oaPath][verb] = {
          operationId: `${ctrl.name}.${name}`,
          tags: [ctrl.name.replace(/Controller$/, '')],
          ...(params.length
            ? {
                parameters: params.map((p) => ({
                  name: p,
                  in: 'path',
                  required: true,
                  schema: /id$/i.test(p) ? { type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000000' } : { type: 'string', example: 'x' },
                })),
              }
            : {}),
          responses: { default: { description: 'Respons' } },
          ...(isPublic ? { security: [] } : {}),
        };
      }
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'PaceTara API', version: '1' },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    security: [{ bearer: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/openapi.js');
if (isMain) {
  const out = process.argv[2] ?? 'openapi.json';
  const server = process.argv[3] ?? 'http://localhost:3000';
  const spec = buildSpec(server);
  writeFileSync(out, JSON.stringify(spec, null, 2));
  console.log(`${Object.keys(spec.paths).length} jalur ditulis ke ${out}`);
}
