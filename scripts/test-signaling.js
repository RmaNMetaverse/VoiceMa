#!/usr/bin/env node
/**
 * End-to-end exercise of the signalling protocol against a running server.
 *   node scripts/test-signaling.js [wss://host:port/ws]
 */
import { WebSocket } from 'ws';

const URL = process.argv[2] ?? 'wss://localhost:8443/ws';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local self-signed CA

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

function client(name) {
  const ws = new WebSocket(URL, { rejectUnauthorized: false });
  const inbox = [];
  const waiters = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  const api = {
    ws,
    name,
    id: null,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Resolves with the first message matching `match`, past or future. */
    wait(match, timeout = 4000) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`timeout waiting (${name})`));
          }
        }, timeout);
      });
    },
    open: () => new Promise((res) => ws.on('open', res))
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ESC = String.fromCharCode(27);

async function run() {
  console.log(`\nSignalling test against ${URL}\n`);

  const a = client('alice');
  const b = client('bob');
  await Promise.all([a.open(), b.open()]);

  a.send({ t: 'hello', name: 'Alice', hue: 250 });
  b.send({ t: 'hello', name: 'Bob', hue: 20 });

  const wa = await a.wait((m) => m.t === 'welcome');
  const wb = await b.wait((m) => m.t === 'welcome');
  a.id = wa.self.id;
  b.id = wb.self.id;

  check('both clients receive welcome', !!a.id && !!b.id);
  check('welcome carries channels', Array.isArray(wa.channels) && wa.channels.length > 0,
    `${wa.channels.length} channels`);
  check('display name is echoed back', wa.self.name === 'Alice');

  // --- join ------------------------------------------------------
  a.send({ t: 'join', channel: 'general' });
  b.send({ t: 'join', channel: 'general' });

  const roster = await b.wait(
    (m) => m.t === 'roster' && m.users.filter((u) => u.channel === 'general').length === 2
  );
  check('roster shows both users in the channel', true,
    roster.users.filter((u) => u.channel === 'general').map((u) => u.name).join(' + '));
  const general = roster.channels.find((c) => c.id === 'general');
  check('channel occupancy is counted', general?.count === 2, `count=${general?.count}`);

  // --- signalling relay ------------------------------------------
  a.send({ t: 'signal', to: b.id, payload: { sdp: { type: 'offer', sdp: 'v=0-test' } } });
  const relayed = await b.wait((m) => m.t === 'signal');
  check('SDP is relayed to the right peer', relayed.from === a.id && relayed.payload.sdp.sdp === 'v=0-test');

  // --- state ------------------------------------------------------
  a.send({ t: 'state', mic: 'open', deaf: false, speaking: true });
  const st = await b.wait((m) => m.t === 'user-state' && m.id === a.id);
  check('speaking state propagates', st.speaking === true && st.mic === 'open');

  // --- chat -------------------------------------------------------
  a.send({ t: 'chat', text: 'hello from the test' });
  const chat = await b.wait((m) => m.t === 'chat');
  check('chat reaches the channel', chat.message.text === 'hello from the test');

  // --- isolation between channels ---------------------------------
  // Made here rather than assumed from config.json, which ships one channel.
  b.send({ t: 'channel:create', name: 'Side Room' });
  const side = await b.wait((m) => m.t === 'channel:created');
  check('an open channel can be created', side.locked === false, side.id);

  b.send({ t: 'join', channel: side.id });
  await b.wait((m) => m.t === 'roster' && m.users.find((u) => u.id === b.id)?.channel === side.id);
  const before = b.inbox.length;
  a.send({ t: 'chat', text: 'should not reach bob' });
  a.send({ t: 'signal', to: b.id, payload: { sdp: { type: 'offer', sdp: 'leak' } } });
  await sleep(400);
  const leaked = b.inbox
    .slice(before)
    .some((m) => (m.t === 'chat' && m.message.text === 'should not reach bob') ||
                 (m.t === 'signal' && m.payload?.sdp?.sdp === 'leak'));
  check('chat and signals do not cross channels', !leaked);

  // --- history backfill -------------------------------------------
  b.send({ t: 'join', channel: 'general' });
  // Match the backfill for THIS run: a server with history from an earlier run
  // sends Bob a chat:history on his first join too, and wait() also matches
  // messages already sitting in the inbox.
  const history = await b.wait(
    (m) => m.t === 'chat:history' && m.messages.some((x) => x.text === 'should not reach bob')
  );
  check('joining backfills recent chat', history.messages.length >= 2,
    `${history.messages.length} messages`);
  check(
    'backfill only contains this channel',
    history.messages.every((x) => x.channel === 'general'),
    history.channel
  );

  // Side Room is empty again now; tidy up so reruns start clean.
  b.send({ t: 'channel:delete', id: side.id });
  await b.wait((m) => m.t === 'roster' && !m.channels.some((c) => c.id === side.id));

  // --- channel lifecycle -------------------------------------------
  a.send({ t: 'channel:create', name: 'Test Room' });
  const created = await a.wait((m) => m.t === 'channel:created');
  check('user channel is created', !!created.id, created.id);

  a.send({ t: 'channel:delete', id: created.id });
  const afterDelete = await a.wait(
    (m) => m.t === 'roster' && !m.channels.some((c) => c.id === created.id)
  );
  check('empty user channel can be deleted', !!afterDelete);

  const permanent = afterDelete.channels.find((c) => c.id === 'general');
  a.send({ t: 'channel:delete', id: 'general' });
  await sleep(300);
  const stillThere = a.inbox
    .filter((m) => m.t === 'roster')
    .at(-1)
    .channels.some((c) => c.id === 'general');
  check('configured channels cannot be deleted', stillThere && !!permanent);

  // --- input hardening ---------------------------------------------
  // Control characters must go; ordinary spaces must survive.
  a.send({ t: 'rename', name: '  Ana' + ESC + '[31m Maria  ' });
  const renamed = await a.wait(
    (m) => m.t === 'roster' && m.users.find((u) => u.id === a.id)?.name !== 'Alice'
  );
  const newName = renamed.users.find((u) => u.id === a.id).name;
  check('control characters are stripped from names', !/[\u0000-\u001f]/.test(newName),
    JSON.stringify(newName));
  check('spaces inside names survive', newName === 'Ana[31m Maria', JSON.stringify(newName));
  check('names are trimmed', !/^\s|\s$/.test(newName));

  // --- locked channels ---------------------------------------------
  a.send({ t: 'channel:create', name: 'Vault', password: 'hunter2' });
  const vault = await a.wait((m) => m.t === 'channel:created' && m.locked);
  check('a channel can be created with a password', vault.locked === true, vault.id);

  const listed = await a.wait(
    (m) => m.t === 'roster' && m.channels.some((c) => c.id === vault.id)
  );
  const vaultPublic = listed.channels.find((c) => c.id === vault.id);
  check('locked channels are flagged to clients', vaultPublic.locked === true);
  check(
    'password hash and salt never reach clients',
    !('hash' in vaultPublic) && !('salt' in vaultPublic) && !('password' in vaultPublic),
    Object.keys(vaultPublic).join(',')
  );

  b.send({ t: 'join', channel: vault.id });
  const noPass = await b.wait((m) => m.t === 'join:denied');
  check('joining without a password is refused', noPass.channel === vault.id);

  b.send({ t: 'join', channel: vault.id, password: 'wrong' });
  const badPass = await b.wait((m) => m.t === 'join:denied' && m.reason.includes('not right'));
  check('joining with the wrong password is refused', !!badPass);

  const stillOut = a.inbox
    .filter((m) => m.t === 'roster')
    .at(-1)
    .users.find((u) => u.id === b.id).channel;
  check('a refused join does not move the user', stillOut !== vault.id, `still in ${stillOut}`);

  b.send({ t: 'join', channel: vault.id, password: 'hunter2' });
  const gotIn = await b.wait(
    (m) => m.t === 'roster' && m.users.find((u) => u.id === b.id)?.channel === vault.id
  );
  check('the right password gets you in', !!gotIn);

  b.send({ t: 'join', channel: 'general' });
  await b.wait((m) => m.t === 'roster' && m.users.find((u) => u.id === b.id)?.channel === 'general');
  a.send({ t: 'channel:delete', id: vault.id });
  await a.wait((m) => m.t === 'roster' && !m.channels.some((c) => c.id === vault.id));

  a.send({ t: 'chat', text: 'x'.repeat(5000) });
  const long = await a.wait((m) => m.t === 'chat' && m.message.text.startsWith('xxx'));
  check('long chat is truncated', long.message.text.length <= 800, `${long.message.text.length} chars`);

  // --- disconnect ---------------------------------------------------
  a.ws.close();
  const gone = await b.wait(
    (m) => m.t === 'roster' && !m.users.some((u) => u.id === a.id),
    5000
  );
  check('leaving removes the user from the roster', !!gone);

  b.ws.close();

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\ntest error:', err.message, '\n');
  process.exit(1);
});
