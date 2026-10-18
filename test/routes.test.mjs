import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { QQMusicService } from '../lib/index.js';

function makeService() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-routes-'));
  const service = new QQMusicService(
    {},
    {
      home,
      watcher: {
        child: null,
        helperMissing: false,
        lastError: '',
        start() {},
        stop() {},
        getState: () => ({ available: false, session: null, reason: 'no-session' }),
      },
      netease: {
        path: '',
        lastError: '',
        start() {},
        stop() {},
        getState: () => ({ available: false, session: null, reason: 'no-session' }),
      },
      resolver: async () => ({ ok: false, reason: 'not-found', message: 'no' }),
      config: { enabled: true },
    },
  );
  return { service, home };
}

function request(method, body, headers = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = '/dsh-pet-qqmusic/config.json';
  req.headers = headers;
  return req;
}

function response() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
  return res;
}

test('写配置必须带 JSON content-type（本地 CSRF 防护）', async () => {
  const { service, home } = makeService();
  const noType = response();
  await service.handle(request('POST', '{"offsetMs":123}'), noType);
  assert.equal(noType.status, 415);
  assert.equal(service.config.offsetMs, 600);

  const withType = response();
  await service.handle(
    request('POST', '{"offsetMs":123}', { 'content-type': 'application/json' }),
    withType,
  );
  assert.equal(withType.status, 200);
  assert.equal(service.config.offsetMs, 123);
  rmSync(home, { recursive: true, force: true });
});
