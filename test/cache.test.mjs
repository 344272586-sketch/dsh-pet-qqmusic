import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { QQMusicService } from '../lib/index.js';

function makeService() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-cache-'));
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

test('歌词缓存 schema 变更后旧缓存失效并被清掉', () => {
  const { service, home } = makeService();
  service._ensureDirs();
  const legacy = service._cachePath('legacy');
  writeFileSync(legacy, JSON.stringify({ v: 1, at: Date.now(), track: {}, lines: [{ t: 0, text: 'old' }] }));
  assert.equal(service._readCache('legacy'), null);
  assert.equal(existsSync(legacy), false, '旧 schema 文件应删除');

  service._writeCache('fresh', { track: { title: 'x' }, lines: [{ t: 0, text: 'new' }] });
  const got = service._readCache('fresh');
  assert.equal(got.v, 2);
  assert.equal(got.lines[0].text, 'new');
  rmSync(home, { recursive: true, force: true });
});
