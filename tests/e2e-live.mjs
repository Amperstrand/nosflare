// Live e2e NIP coverage for wss://relay.cashu.email.
// Node 22+ provides a global WebSocket; signing via @noble/curves.
// Run: npm run test:e2e

import fs from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/curves/abstract/utils';

const RELAY = 'wss://relay.cashu.email';
const HTTP = 'https://relay.cashu.email/';
const CLEANUP_TAG = 'nip-test-suite-cleanup';

const ACCOUNT = 'b8b395a6029fc23bcc4f4ac31fcd1f1c';
const DB = '94807ebd-6404-42a0-ab43-941958f416c1';

const C = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' };
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;

function log(name, status, detail = '') {
  const tag = status === 'PASS' ? `${C.green}[PASS]${C.reset}`
    : status === 'SKIP' ? `${C.yellow}[SKIP]${C.reset}`
    : `${C.red}[FAIL]${C.reset}`;
  console.log(`${tag} ${name}${detail ? ': ' + C.dim + detail + C.reset : ''}`);
  if (status === 'PASS') pass++;
  else if (status === 'SKIP') skip++;
  else fail++;
}

function freshKeypair() {
  const priv = randomBytes(32);
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(schnorr.getPublicKey(priv)) };
}

function canonical(pubkey, created_at, kind, tags, content) {
  return JSON.stringify([0, pubkey, created_at, kind, tags, content]);
}

function ensureCleanupTag(tags) {
  return tags.some((t) => t[0] === 't' && t[1] === CLEANUP_TAG) ? tags : [...tags, ['t', CLEANUP_TAG]];
}

function buildEvent(kp, kind, content, tags = [], created_at) {
  const allTags = ensureCleanupTag(tags);
  const ts = created_at ?? Math.floor(Date.now() / 1000);
  const idBytes = sha256(encoder.encode(canonical(kp.publicKey, ts, kind, allTags, content)));
  return {
    id: bytesToHex(idBytes),
    pubkey: kp.publicKey,
    created_at: ts,
    kind,
    tags: allTags,
    content,
    sig: bytesToHex(schnorr.sign(idBytes, hexToBytes(kp.privateKey))),
  };
}

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const to = setTimeout(() => { ws.close(); reject(new Error(`connect timeout: ${label}`)); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(to); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(to); reject(new Error(`connect error: ${label}`)); }, { once: true });
  });
}

function close(ws) {
  if (!ws || ws.readyState >= 2) return Promise.resolve();
  return new Promise((r) => {
    ws.addEventListener('close', r, { once: true });
    try { ws.close(); } catch { r(); }
    setTimeout(r, 1500);
  });
}

// Resolve next WS message matching predicate; rejects on timeout.
function recv(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`recv timeout ${timeoutMs}ms`)), timeoutMs);
    const handler = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (predicate(msg)) { clearTimeout(to); ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
  });
}

async function sendEventAndWaitOK(ws, ev, timeoutMs = 12000) {
  const p = recv(ws, (m) => m[0] === 'OK' && m[1] === ev.id, timeoutMs).catch(() => null);
  ws.send(JSON.stringify(['EVENT', ev]));
  return p;
}

function sub(ws, subId, filter) {
  ws.send(JSON.stringify(['REQ', subId, filter]));
}

function closeSub(ws, subId) {
  try { ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
}

// --- D1 cleanup via Cloudflare REST API ---
// Test events all carry the tag ["t","nip-test-suite-cleanup"]. We delete child
// tables first (while event ids still resolve) then the events row itself.
async function cleanup() {
  let token;
  try {
    const toml = fs.readFileSync(process.env.HOME + '/Library/Preferences/.wrangler/config/default.toml', 'utf8');
    token = toml.match(/oauth_token = "([^"]+)"/)[1];
  } catch (e) {
    console.log(`${C.red}[CLEANUP]${C.reset} could not read wrangler token: ${e.message}`);
    return { ok: false };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const where = "(SELECT id FROM events WHERE tags LIKE '%nip-test-suite-cleanup%')";
  const statements = [
    `DELETE FROM event_tags_cache_multi WHERE event_id IN ${where}`,
    `DELETE FROM content_hashes WHERE event_id IN ${where}`,
    `DELETE FROM tags WHERE event_id IN ${where}`,
    `DELETE FROM events WHERE tags LIKE '%nip-test-suite-cleanup%'`,
  ];
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ sql: statements.join(';') }) });
  const j = await res.json();
  if (!j.success) {
    console.log(`${C.red}[CLEANUP]${C.reset} D1 delete failed: ${JSON.stringify(j.errors)}`);
    return { ok: false };
  }
  // verify zero remaining
  const v = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ sql: `SELECT (SELECT COUNT(*) FROM events WHERE tags LIKE '%nip-test-suite-cleanup%') AS ev, (SELECT COUNT(*) FROM tags WHERE tag_name='t' AND tag_value='nip-test-suite-cleanup') AS tg, (SELECT COUNT(*) FROM event_tags_cache_multi WHERE tag_type='t' AND tag_value='nip-test-suite-cleanup') AS cm` }) });
  const vj = await v.json();
  const counts = vj.result?.[0]?.results?.[0] || {};
  const clean = Number(counts.ev) === 0 && Number(counts.tg) === 0 && Number(counts.cm) === 0;
  const meta = j.result?.map((r) => r.meta?.changes ?? 0).join(',');
  console.log(`${clean ? C.green : C.red}[CLEANUP]${C.reset} rows-affected=[${meta}] remaining=${JSON.stringify(counts)}`);
  return { ok: clean, meta, counts };
}

// ============================ TESTS ============================

async function test_01_auth_disabled() {
  const name = 'NIP-42 AUTH-disabled: relay must not send AUTH';
  let ws;
  try {
    ws = await connect('auth-check');
    let sawAuth = false;
    ws.addEventListener('message', (e) => { try { if (JSON.parse(e.data)[0] === 'AUTH') sawAuth = true; } catch {} });
    await sleep(1500);
    log(name, sawAuth ? 'FAIL' : 'PASS', sawAuth ? 'received AUTH frame' : 'no AUTH frame within 1.5s');
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_02_cors_nip11() {
  const name = 'NIP-11 CORS: Access-Control-Allow-Origin: *';
  try {
    const r = await fetch(HTTP, { headers: { Accept: 'application/nostr+json', Origin: 'https://example.test' } });
    const acao = r.headers.get('access-control-allow-origin');
    const ctype = r.headers.get('content-type') || '';
    const body = await r.json();
    const nips = body.supported_nips || [];
    log(name,
      r.status === 200 && acao === '*' && ctype.includes('nostr+json') && nips.includes(1) ? 'PASS' : 'FAIL',
      `status=${r.status} acao=${acao} ctype=${ctype} nips=${nips.length}`);
  } catch (e) { log(name, 'FAIL', e.message); }
}

async function test_03_replaceable_kind0() {
  const name = 'NIP-01 replaceable: kind 0 keeps newest';
  const kp = freshKeypair();
  const t = Math.floor(Date.now() / 1000);
  const v1 = buildEvent(kp, 0, JSON.stringify({ name: 'v1', uniq: t + '-a' }), [], t);
  const v2 = buildEvent(kp, 0, JSON.stringify({ name: 'v2', uniq: t + '-b' }), [], t + 60);
  let ws;
  try {
    ws = await connect('repl');
    await sendEventAndWaitOK(ws, v1);
    await sleep(600);
    await sendEventAndWaitOK(ws, v2);
    await sleep(800);
    const sid = 'r3';
    sub(ws, sid, { authors: [kp.publicKey], kinds: [0] });
    const got = [];
    const eose = recv(ws, (m) => m[0] === 'EOSE' && m[1] === sid, 8000).catch(() => null);
    while (true) {
      const ev = await Promise.race([recv(ws, (m) => m[0] === 'EVENT' && m[1] === sid, 3000).catch(() => null), eose.then(() => null)]);
      if (!ev) break;
      got.push(ev[2]);
    }
    await eose;
    closeSub(ws, sid);
    const ok = got.length === 1 && got[0].id === v2.id;
    log(name, ok ? 'PASS' : 'FAIL', `returned ${got.length} event(s), newest=${got[0]?.id === v2.id}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_04_deletion_kind5() {
  const name = 'NIP-09 deletion: kind 5 removes target';
  const kp = freshKeypair();
  const target = buildEvent(kp, 1, 'root note for deletion test ' + Math.random());
  const del = buildEvent(kp, 5, '', [['e', target.id]]);
  let ws;
  try {
    ws = await connect('del');
    await sendEventAndWaitOK(ws, target);
    await sleep(800);
    const sid1 = 'd1';
    sub(ws, sid1, { ids: [target.id] });
    const before = await recv(ws, (m) => m[0] === 'EVENT' && m[1] === sid1, 5000).catch(() => null);
    const beforeEose = await recv(ws, (m) => m[0] === 'EOSE' && m[1] === sid1, 5000).catch(() => null);
    closeSub(ws, sid1);
    await sendEventAndWaitOK(ws, del);
    await sleep(1000);
    const sid2 = 'd2';
    sub(ws, sid2, { ids: [target.id] });
    const after = await recv(ws, (m) => m[0] === 'EVENT' && m[1] === sid2, 4000).catch(() => null);
    await recv(ws, (m) => m[0] === 'EOSE' && m[1] === sid2, 5000).catch(() => null);
    closeSub(ws, sid2);
    const ok = before && !after;
    log(name, ok ? 'PASS' : 'FAIL', `present-before=${!!before} present-after=${!!after}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_05_nip12_tag_filters() {
  const name = 'NIP-12 tag filters: #p and #t';
  const kp = freshKeypair();
  const bob = freshKeypair();
  const tval = 'e2etag-' + Math.random().toString(36).slice(2, 10);
  const ev = buildEvent(kp, 1, 'nip12 tag filter ' + tval, [['p', bob.publicKey], ['t', tval]]);
  let ws;
  try {
    ws = await connect('nip12');
    await sendEventAndWaitOK(ws, ev);
    await sleep(800);
    const byP = await queryOne(ws, 'tp', { '#p': [bob.publicKey], authors: [kp.publicKey] });
    const byT = await queryOne(ws, 'tt', { '#t': [tval], authors: [kp.publicKey] });
    const ok = byP?.id === ev.id && byT?.id === ev.id;
    log(name, ok ? 'PASS' : 'FAIL', `#p-hit=${byP?.id === ev.id} #t-hit=${byT?.id === ev.id}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_06_nip33_parameterized() {
  const name = 'NIP-33 parameterized replaceable: kind 30078 newest only';
  const kp = freshKeypair();
  const t = Math.floor(Date.now() / 1000);
  const dtag = 'app-' + Math.random().toString(36).slice(2, 10);
  const v1 = buildEvent(kp, 30078, 'v1 ' + dtag, [['d', dtag]], t);
  const v2 = buildEvent(kp, 30078, 'v2 ' + dtag, [['d', dtag]], t + 60);
  let ws;
  try {
    ws = await connect('nip33');
    await sendEventAndWaitOK(ws, v1);
    await sleep(600);
    await sendEventAndWaitOK(ws, v2);
    await sleep(800);
    const got = await queryAll(ws, 'n33', { authors: [kp.publicKey], kinds: [30078] });
    const ok = got.length === 1 && got[0].id === v2.id;
    log(name, ok ? 'PASS' : 'FAIL', `returned ${got.length}, newest=${got[0]?.id === v2.id}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_07_concurrent_broadcast() {
  const name = 'Concurrent broadcast: subscriber gets realtime EVENT';
  const kp = freshKeypair();
  const ev = buildEvent(kp, 1, 'broadcast ' + Math.random());
  let sub_ws, pub_ws;
  try {
    sub_ws = await connect('sub');
    pub_ws = await connect('pub');
    const sid = 'bc';
    sub(sub_ws, sid, { authors: [kp.publicKey], kinds: [1] });
    await recv(sub_ws, (m) => m[0] === 'EOSE' && m[1] === sid, 8000).catch(() => null);
    const arrived = recv(sub_ws, (m) => m[0] === 'EVENT' && m[1] === sid && m[2]?.id === ev.id, 10000).catch(() => null);
    await sendEventAndWaitOK(pub_ws, ev);
    const got = await arrived;
    closeSub(sub_ws, sid);
    const ok = got?.[2]?.id === ev.id;
    log(name, ok ? 'PASS' : 'FAIL', ok ? 'realtime EVENT received' : 'no realtime EVENT');
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(sub_ws);
  await close(pub_ws);
}

async function test_08_rate_limit() {
  const name = 'Rate limit: 10/min/pubkey, 11+ rejected';
  const kp = freshKeypair();
  let ws;
  try {
    ws = await connect('rate');
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 12; i++) {
      const ev = buildEvent(kp, 1, `rate ${i} ` + Math.random(), [['t', 'ratetest-' + i]]);
      const ok = await sendEventAndWaitOK(ws, ev, 6000);
      if (ok && ok[2] === true) accepted++;
      else rejected++;
      await sleep(120);
    }
    const ok = accepted === 10 && rejected >= 2;
    log(name, ok ? 'PASS' : 'FAIL', `accepted=${accepted} rejected=${rejected} (expect 10 accepted, >=2 rejected)`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_09_notice() {
  const name = 'NIP-15 NOTICE: malformed + incomplete rejected';
  let ws;
  try {
    ws = await connect('notice');
    ws.send('garbage');
    const m1 = await Promise.race([
      recv(ws, (m) => m[0] === 'NOTICE' || m[0] === 'CLOSED', 4000).catch(() => null),
      sleep(4000).then(() => null),
    ]);
    const badEv = { id: bytesToHex(randomBytes(32)), created_at: Math.floor(Date.now() / 1000), kind: 1, tags: [], content: 'x', sig: bytesToHex(randomBytes(64)) };
    ws.send(JSON.stringify(['EVENT', badEv]));
    const m2 = await Promise.race([
      recv(ws, (m) => (m[0] === 'NOTICE') || (m[0] === 'OK' && m[1] === badEv.id && m[2] === false), 6000).catch(() => null),
      sleep(6000).then(() => null),
    ]);
    const ok = !!m1 && !!m2;
    log(name, ok ? 'PASS' : 'FAIL', `malformed->${m1?.[0] || 'none'} incomplete->${m2?.[0] || 'none'}${m2?.[2] === false ? '(OK:false)' : ''}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_10_eose() {
  const name = 'NIP-15 EOSE: arrives within 2s on empty result';
  let ws;
  try {
    ws = await connect('eose');
    const sid = 'eos';
    const start = Date.now();
    sub(ws, sid, { authors: [freshKeypair().publicKey], limit: 0 });
    const eose = await recv(ws, (m) => m[0] === 'EOSE' && m[1] === sid, 4000).catch(() => null);
    const ms = Date.now() - start;
    closeSub(ws, sid);
    const ok = eose && ms < 2000;
    log(name, ok ? 'PASS' : 'FAIL', `EOSE=${!!eose} in ${ms}ms`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_11_ephemeral() {
  const name = 'NIP-16 ephemeral: broadcast but not stored';
  const kp = freshKeypair();
  const ev = buildEvent(kp, 20000, 'ephemeral ' + Math.random());
  let sub_ws, pub_ws, chk_ws;
  try {
    sub_ws = await connect('eph-sub');
    pub_ws = await connect('eph-pub');
    const sid = 'eph';
    sub(sub_ws, sid, { authors: [kp.publicKey], kinds: [20000] });
    await recv(sub_ws, (m) => m[0] === 'EOSE' && m[1] === sid, 8000).catch(() => null);
    const arrived = recv(sub_ws, (m) => m[0] === 'EVENT' && m[1] === sid && m[2]?.id === ev.id, 10000).catch(() => null);
    await sendEventAndWaitOK(pub_ws, ev, 6000);
    const broadcast = await arrived;
    closeSub(sub_ws, sid);
    await sleep(800);
    chk_ws = await connect('eph-chk');
    const found = await queryOne(chk_ws, 'ephchk', { ids: [ev.id] });
    const ok = broadcast?.[2]?.id === ev.id && !found;
    log(name, ok ? 'PASS' : 'FAIL', `broadcast=${!!broadcast} stored=${!!found} (expect broadcast=true stored=false)`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(sub_ws); await close(pub_ws); await close(chk_ws);
}

async function test_20_bad_sig_reject() {
  const name = 'NIP-20 OK reject: bad signature';
  const kp = freshKeypair();
  const ev = buildEvent(kp, 1, 'bad sig ' + Math.random());
  const sigArr = ev.sig.split('');
  const last = sigArr[sigArr.length - 1];
  sigArr[sigArr.length - 1] = last === 'a' ? 'b' : 'a';
  ev.sig = sigArr.join('');
  let ws;
  try {
    ws = await connect('badsig');
    const ok = await sendEventAndWaitOK(ws, ev, 8000);
    const rejected = ok && ok[2] === false;
    const msg = (ok?.[3] || '').toLowerCase();
    const ok2 = rejected && /sig|invalid|verify/.test(msg);
    log(name, ok2 ? 'PASS' : 'FAIL', `accepted=${ok?.[2]} msg="${ok?.[3]?.slice(0, 80) || ''}"`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_13_dm_kind4() {
  const name = 'NIP-17 DM: kind 4 retrieved by recipient #p';
  const alice = freshKeypair();
  const bob = freshKeypair();
  const cipher = 'encrypted-payload-' + Math.random();
  const ev = buildEvent(alice, 4, cipher, [['p', bob.publicKey]]);
  let ws;
  try {
    ws = await connect('dm');
    await sendEventAndWaitOK(ws, ev);
    await sleep(800);
    const found = await queryOne(ws, 'dm', { '#p': [bob.publicKey], kinds: [4] });
    const ok = found?.id === ev.id;
    log(name, ok ? 'PASS' : 'FAIL', `found=${!!found} id-match=${found?.id === ev.id}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_13b_gift_wrap_1059() {
  const name = 'NIP-17 gift-wrap: kind 1059 stored';
  const kp = freshKeypair();
  const bob = freshKeypair();
  const ev = buildEvent(kp, 1059, 'gift-wrap-recipient-' + Math.random(), [['p', bob.publicKey]]);
  let ws;
  try {
    ws = await connect('gw');
    const ok = await sendEventAndWaitOK(ws, ev, 8000);
    await sleep(800);
    const found = await queryOne(ws, 'gw', { ids: [ev.id] });
    const pass_ = ok?.[2] === true && found?.id === ev.id;
    log(name, pass_ ? 'PASS' : 'FAIL', `ok=${ok?.[2]} stored=${!!found}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

async function test_14_reaction_kind7() {
  const name = 'NIP-25 reaction: kind 7 found via #e';
  const kp = freshKeypair();
  const root = buildEvent(kp, 1, 'reaction root ' + Math.random());
  const react = buildEvent(kp, 7, '+', [['e', root.id], ['p', kp.publicKey]]);
  let ws;
  try {
    ws = await connect('react');
    await sendEventAndWaitOK(ws, root);
    await sleep(600);
    await sendEventAndWaitOK(ws, react);
    await sleep(800);
    const found = await queryOne(ws, 'rx', { '#e': [root.id], kinds: [7] });
    const ok = found?.id === react.id;
    log(name, ok ? 'PASS' : 'FAIL', `found=${!!found} id-match=${found?.id === react.id}`);
  } catch (e) { log(name, 'FAIL', e.message); }
  await close(ws);
}

// --- query helpers (open sub, collect until EOSE) ---
async function queryAll(ws, sid, filter) {
  sub(ws, sid, filter);
  const out = [];
  const eoseP = recv(ws, (m) => m[0] === 'EOSE' && m[1] === sid, 8000).catch(() => null);
  while (true) {
    const ev = await Promise.race([recv(ws, (m) => m[0] === 'EVENT' && m[1] === sid, 3000).catch(() => null), eoseP.then(() => 'done')]);
    if (!ev || ev === 'done') break;
    out.push(ev[2]);
  }
  await eoseP;
  closeSub(ws, sid);
  return out;
}

async function queryOne(ws, sid, filter) {
  const all = await queryAll(ws, sid, filter);
  return all[0] || null;
}

// ============================ RUNNER ============================

const TESTS = [
  ['01', test_01_auth_disabled],
  ['02', test_02_cors_nip11],
  ['03', test_03_replaceable_kind0],
  ['04', test_04_deletion_kind5],
  ['05', test_05_nip12_tag_filters],
  ['06', test_06_nip33_parameterized],
  ['07', test_07_concurrent_broadcast],
  ['08', test_08_rate_limit],
  ['09', test_09_notice],
  ['10', test_10_eose],
  ['11', test_11_ephemeral],
  ['12', test_20_bad_sig_reject],
  ['13', test_13_dm_kind4],
  ['14', test_14_reaction_kind7],
  ['13b', test_13b_gift_wrap_1059],
];

(async () => {
  console.log(`${C.cyan}=== e2e NIP coverage: ${RELAY} ===${C.reset}\n`);
  for (const [, fn] of TESTS) {
    try { await fn(); }
    catch (e) { console.log(`${C.red}UNHANDLED${C.reset} ${fn.name}: ${e.message}`); fail++; }
  }
  console.log(`\n${C.cyan}--- cleanup ---${C.reset}`);
  const cleanupRes = await cleanup();
  console.log(`\n${C.cyan}=== SUMMARY ===${C.reset}`);
  const cleanupColor = cleanupRes.ok ? C.green : C.red;
  console.log(`${C.green}PASS ${pass}${C.reset}  ${C.red}FAIL ${fail}${C.reset}  ${C.yellow}SKIP ${skip}${C.reset}  cleanup=${cleanupColor}${cleanupRes.ok ? 'ok' : 'INCOMPLETE'}${C.reset}`);
  process.exit(fail === 0 ? 0 : 1);
})();
