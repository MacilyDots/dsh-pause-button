import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function makeHost() {
  const listeners = new Map();
  const disposers = [];
  const rpcHandlers = new Map();
  const ctx = {
    webServer: {
      register(r) {
        rpcHandlers.set(r.path, r.handler);
        return () => rpcHandlers.delete(r.path);
      },
    },
    connection: { requestRejection: () => undefined },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    get() { return undefined; },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return () => { if (typeof d === 'function') d(); };
    },
    fire(name, payload, next) {
      const arr = listeners.get(name) || [];
      return arr[0]?.(payload, next);
    },
    dispose() {
      while (disposers.length) {
        try { disposers.pop()(); } catch {}
      }
    },
  };
  apply(ctx);
  return { ctx, listeners, rpcHandlers };
}

function pauseReq(sessionId) {
  return {
    method: 'POST',
    url: '/dsh-pause-button/pause',
    headers: { 'content-type': 'application/json' },
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ sessionId })));
      if (ev === 'end') cb();
    },
  };
}

test('agent/disposed releases paused gate and avoids leak', async () => {
  const { ctx, listeners, rpcHandlers } = makeHost();
  const agent = { id: 'sess-1' };
  listeners.get('agent/status')[0]({ agent, status: 'running' });
  const rpc = rpcHandlers.get('/dsh-pause-button');
  assert.ok(rpc);
  await rpc(pauseReq('sess-1'), { writeHead() {}, end() {} });

  let resumed = false;
  const p = ctx.fire('agent/pre-step', { agent, step: 2 }, async () => { resumed = true; });
  ctx.fire('agent/disposed', { agent });
  await p;
  assert.equal(resumed, true);
  ctx.dispose();
});

test('ctx.effect disposer releases paused turn on unload', async () => {
  const { ctx, listeners, rpcHandlers } = makeHost();
  const agent = { id: 'sess-paused' };
  listeners.get('agent/status')[0]({ agent, status: 'running' });
  const rpc = rpcHandlers.get('/dsh-pause-button');
  await rpc(pauseReq('sess-paused'), { writeHead() {}, end() {} });

  let resumed = false;
  const p = ctx.fire('agent/pre-step', { agent, step: 2 }, async () => { resumed = true; });
  ctx.dispose();
  await p;
  assert.equal(resumed, true);
});
