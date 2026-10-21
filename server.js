'use strict';
// Sertão — servidor do jogo online. Sem dependências: só o Node.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const PORT = process.env.PORT || 3000, SP = +process.env.SPEED || 1; // SPEED só para testes
const INDEX = path.join(__dirname, 'public', 'index.html');

const RL = { coronel: { n: 'Coronel', e: '🎩' }, jagunco: { n: 'Jagunço', e: '🔫' }, cangaceiro: { n: 'Cangaceiro', e: '🤠' }, mascate: { n: 'Mascate', e: '🎒' }, rezadeira: { n: 'Rezadeira', e: '🙏' }, frade: { n: 'Frade', e: '✝️' } };
const ACTS = {
  renda: { n: 'Renda' }, ajuda: { n: 'Ajuda Externa', b: ['coronel'] }, golpe: { n: 'Golpe de Estado', t: 1, cost: 7 },
  taxar: { n: 'Taxar', r: 'coronel' }, extorquir: { n: 'Extorquir', r: 'cangaceiro', t: 1, b: ['cangaceiro', 'mascate', 'frade'] },
  assassinar: { n: 'Assassinar', r: 'jagunco', t: 1, cost: 3, b: ['rezadeira'] }, trocar: { n: 'Trocar (2)', r: 'mascate' },
  trocar1: { n: 'Trocar (1)', r: 'frade' }, investigar: { n: 'Investigar', r: 'frade', t: 1 }
};
const BOTS = ['Zé Piaba', 'Dona Chica', 'Seu Nonato', 'Bia do Cordel', 'Tião', 'Sinhá Maria', 'Compadre Totó', 'Nega Lia', 'Raimundo', 'Mãe Joana'];
const rooms = new Map();
let PRN = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms / SP));
const rnd = a => a[Math.random() * a.length | 0];
const sh = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]] } return a };
const alive = p => p.cards.filter(c => !c.dead);
const has = (p, r) => alive(p).some(c => c.r === r);
const clean = s => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14);
const isOn = (R, id) => (R.cl.get(id) || { size: 0 }).size > 0;

// ---------- salas e estado enviado aos jogadores ----------
function newCode() { const L = [...'BCDFGHJKLMNPQRSTVWXZ']; let c; do { c = Array.from({ length: 4 }, () => rnd(L)).join('') } while (rooms.has(c)); return c }
function addP(R, id, name, av, bot) { R.players.push({ id, name, av: (((av | 0) % 6) + 6) % 6, bot: !!bot, coins: 2, cards: [], out: 0, turn: 0 }) }
function mkRoom(pid, name, av) {
  const R = { code: newCode(), host: pid, players: [], opts: { reveal: 1, bots: 1 }, phase: 'lobby', deck: [], log: [], evs: [], evn: 0, pr: {}, cl: new Map(), seen: Date.now() };
  rooms.set(R.code, R); addP(R, pid, name, av); return R;
}
function snap(R, pid) {
  const rv = R.opts.reveal, pr = R.pr[pid];
  return {
    code: R.code, phase: R.phase, host: R.host, opts: R.opts, deck: R.deck.length, evn: R.evn, log: R.log.slice(-40),
    players: R.players.map(p => ({
      id: p.id, name: p.name, av: p.av, bot: p.bot, coins: p.coins, out: p.out, turn: p.turn, on: p.bot || isOn(R, p.id),
      // cartas dos outros nunca saem do servidor
      cards: p.cards.map(c => c.dead ? (rv || p.id === pid ? { d: 1, r: c.r } : { d: 1 }) : (p.id === pid ? { r: c.r } : {}))
    })),
    evs: R.evs.filter(e => !e.to || e.to === pid).map(e => ({ ...e, card: e.card && (rv || e.who === pid) ? e.card : undefined })),
    pr: pr && { id: pr.id, q: pr.q, opts: pr.opts, rls: pr.rls, rl: pr.rl, kind: pr.kind, ids: pr.ids, ks: pr.ks, left: Math.max(0, pr.dl - Date.now()) }
  };
}
function push(R) { R.seen = Date.now(); for (const [pid, set] of R.cl) for (const res of set) res.write('data: ' + JSON.stringify(snap(R, pid)) + '\n\n') }
function say(R, t) { R.log.push(t); if (R.log.length > 80) R.log.shift(); push(R) }
function ev(R, e) { R.evs.push({ id: ++R.evn, ...e }); R.evs = R.evs.slice(-8); push(R) }

// ---------- perguntas aos jogadores (com tempo limite) ----------
const ASK_MS = +process.env.ASK_MS || 20000;
function ask(R, p, o, ms, def) {
  return new Promise(res => {
    if (p.bot) return res(def);
    const pr = { id: ++PRN, ...o, dl: Date.now() + ms / SP };
    pr.fin = i => { clearTimeout(pr.t); if (R.pr[p.id] === pr) delete R.pr[p.id]; push(R); res(i) };
    pr.t = setTimeout(() => pr.fin(def), (isOn(R, p.id) ? ms : 4000) / SP);
    R.pr[p.id] = pr; push(R);
  });
}
// pergunta a vários ao mesmo tempo; devolve {p,i} de quem agiu primeiro, ou null se todos passaram
function askAny(R, ps, o, ms) {
  return new Promise(res => {
    ps = ps.filter(p => !p.bot); let n = ps.length, over = 0; if (!n) return res(null);
    const pass = o.opts.length - 1;
    ps.forEach(p => {
      const pr = { id: ++PRN, ...o, n: o.opts.length, any: 1, dl: Date.now() + ms / SP };
      pr.fin = i => {
        if (over || R.pr[p.id] !== pr) return; clearTimeout(pr.t); delete R.pr[p.id];
        if (i < pass) { over = 1; ps.forEach(x => { const q = R.pr[x.id]; if (q && q.any) { clearTimeout(q.t); delete R.pr[x.id] } }); push(R); res({ p, i }) }
        else if (--n === 0) { over = 1; push(R); res(null) } else push(R);
      };
      pr.t = setTimeout(() => pr.fin(pass), (isOn(R, p.id) ? ms : 3000) / SP);
      R.pr[p.id] = pr;
    });
    push(R);
  });
}

// ---------- regras do jogo ----------
async function lose(R, p, why = '') {
  const a = alive(p); if (!a.length) return;
  let c = a[0];
  if (a.length > 1) {
    if (p.bot) c = rnd(a);
    else c = a[await ask(R, p, { q: 'Qual influência você perde?', kind: 'btn', opts: a.map(x => RL[x.r].n), rls: a.map(x => x.r), n: a.length }, 25000, Math.random() * a.length | 0)];
  }
  c.dead = 1;
  say(R, p.name + ' perdeu ' + (R.opts.reveal ? RL[c.r].e + ' ' + RL[c.r].n : 'uma influência') + '.');
  if (!alive(p).length) { p.out = 1; say(R, '☠️ ' + p.name + ' foi eliminado.') }
  ev(R, { k: 'lose', who: p.id, card: c.r, out: p.out, why });
  await sleep(2300);
}
async function challenge(R, cl, role) {
  const others = R.players.filter(x => !x.out && x !== cl);
  const h = await askAny(R, others, { q: cl.name + ' diz ser', rl: role, opts: ['Contestar', 'Deixar passar'], kind: 'btn' }, ASK_MS);
  const o = h ? h.p : others.filter(x => x.bot).find(() => Math.random() < .4 / R.players.length);
  if (!o) return true;
  say(R, o.name + ' contesta ' + cl.name + '!');
  if (has(cl, role)) {
    say(R, cl.name + ' mostra ' + RL[role].n + '! ' + o.name + ' perde uma influência.');
    const c = alive(cl).find(x => x.r === role); R.deck.push(c.r); sh(R.deck); c.r = R.deck.shift();
    await lose(R, o, cl.name + ' tinha ' + RL[role].n + '!'); return true;
  }
  say(R, cl.name + ' estava blefando!'); await lose(R, cl, 'Blefe descoberto! 🎭'); return false;
}
async function block(R, a, roles, t, nm) {
  const cands = t ? [t] : R.players.filter(x => !x.out && x !== a);
  const opts = [...roles.map(x => 'Bloquear como ' + RL[x].n), 'Deixar passar'];
  const h = await askAny(R, cands, { q: a.name + ' tenta ' + nm + '. Bloquear?', opts, rls: [...roles, ''], kind: 'btn' }, ASK_MS);
  let b = null, r = null;
  if (h) { b = h.p; r = roles[h.i] }
  else for (const x of cands.filter(x => x.bot)) {
    const own = roles.find(y => has(x, y));
    if (Math.random() < (own ? .6 : .08) * (t ? 1 : 4 / R.players.length)) { b = x; r = own || rnd(roles); break }
  }
  if (!b) return false;
  say(R, b.name + ' bloqueia com ' + RL[r].n + '!');
  return await challenge(R, b, r);
}
async function swap(R, p, n) {
  const d = R.deck.splice(0, n), pool = [...alive(p), ...d.map(r => ({ r }))], keep = alive(p).length;
  while (pool.length > keep) {
    const i = p.bot ? Math.random() * pool.length | 0 : await ask(R, p, { q: 'Devolva uma carta ao baralho:', kind: 'btn', opts: pool.map(c => RL[c.r].n), rls: pool.map(c => c.r), n: pool.length }, 30000, Math.random() * pool.length | 0);
    R.deck.push(pool.splice(i, 1)[0].r);
  }
  sh(R.deck); const rs = pool.map(c => c.r); alive(p).forEach((c, i) => c.r = rs[i]);
  say(R, p.name + ' trocou ' + n + ' carta(s).');
}
async function probe(R, p, t) {
  const a = alive(t); let c = a[0];
  if (a.length > 1) c = t.bot ? rnd(a) : a[await ask(R, t, { q: 'O Frade quer ver uma carta sua. Mostre qual:', kind: 'btn', opts: a.map(x => RL[x.r].n), rls: a.map(x => x.r), n: a.length }, 20000, 0)];
  say(R, p.name + ' olhou uma carta de ' + t.name + '.');
  const sw = p.bot ? Math.random() < .5 : (await ask(R, p, { q: t.name + ' mostrou ' + RL[c.r].e + ' ' + RL[c.r].n + '. O que fazer?', kind: 'btn', opts: ['Deixar com ele', 'Forçar troca'], n: 2 }, 20000, 0)) === 1;
  if (sw) { R.deck.push(c.r); sh(R.deck); c.r = R.deck.shift(); say(R, t.name + ' foi forçado a trocar a carta.') } else say(R, t.name + ' ficou com a carta.');
}
function botPick(p) {
  if (p.coins >= 10 || (p.coins >= 7 && Math.random() < .6)) return 'golpe';
  const ks = Object.keys(ACTS).filter(k => k !== 'golpe' && p.coins >= (ACTS[k].cost || 0));
  const own = ks.filter(k => ACTS[k].r && has(p, ACTS[k].r));
  return rnd(own.length && Math.random() < .6 ? own : ks);
}
async function turn(R, p) {
  R.players.forEach(x => { x.turn = x === p ? 1 : 0 }); push(R);
  let k;
  if (!p.bot) {
    const must = p.coins >= 10, ks = Object.keys(ACTS).filter(k => p.coins >= (ACTS[k].cost || 0) && (!must || k === 'golpe'));
    ev(R, { k: 'turn', to: p.id });
    k = ks[await ask(R, p, { q: 'Sua vez! Escolha a ação:', kind: 'act', ks, n: ks.length }, 45000, ks.indexOf(must ? 'golpe' : 'renda'))];
  } else { k = botPick(p); await sleep(900) }
  const A = ACTS[k], foes = R.players.filter(x => !x.out && x !== p); let t = null;
  if (A.t) t = p.bot ? rnd(foes) : foes[await ask(R, p, { q: 'Escolha o alvo', kind: 'target', ids: foes.map(f => f.id), n: foes.length }, 30000, Math.random() * foes.length | 0)];
  say(R, '<b>' + p.name + '</b>: ' + A.n + (t ? ' em ' + t.name : '') + (A.r ? ' (diz ser ' + RL[A.r].n + ')' : '') + '.');
  if (t && !t.bot) ev(R, { k: 'tgt', to: t.id, sub: A.n });
  p.coins -= A.cost || 0; push(R);
  if (A.r && !await challenge(R, p, A.r)) { p.coins += A.cost || 0; push(R); return }
  if (p.out || (t && t.out)) return;
  if (A.b && await block(R, p, A.b, t, A.n)) { push(R); return }
  if (p.out) return;
  switch (k) {
    case 'renda': p.coins++; break;
    case 'ajuda': p.coins += 2; break;
    case 'taxar': p.coins += 3; break;
    case 'extorquir': { const m = Math.min(2, t.coins); t.coins -= m; p.coins += m; break }
    case 'golpe': case 'assassinar': await lose(R, t, k === 'golpe' ? 'Golpe de Estado!' : 'Assassinado!'); break;
    case 'trocar': await swap(R, p, 2); break;
    case 'trocar1': await swap(R, p, 1); break;
    case 'investigar': await probe(R, p, t); break;
  }
  push(R);
}
async function runGame(R) {
  R.phase = 'play'; R.log = []; R.evs = []; R.pr = {};
  sh(R.players);
  const n = R.players.length, cp = n <= 6 ? 3 : n <= 8 ? 4 : 5;
  R.deck = sh(Object.keys(RL).flatMap(r => Array(cp).fill(r)));
  R.players.forEach(p => { p.coins = 2; p.out = 0; p.turn = 0; p.cards = [{ r: R.deck.shift() }, { r: R.deck.shift() }] });
  say(R, 'Que comece o jogo! ' + n + ' jogadores, ' + cp + ' cartas de cada personagem.');
  try {
    let i = 0;
    while (R.players.filter(x => !x.out).length > 1) {
      const p = R.players[i++ % R.players.length]; if (p.out) continue;
      await turn(R, p); await sleep(500);
    }
    const w = R.players.find(x => !x.out); R.players.forEach(x => x.turn = 0);
    say(R, '🏆 ' + w.name + ' venceu!'); ev(R, { k: 'win', who: w.id });
  } catch (e) { console.error(e); say(R, 'Ocorreu um erro na partida.') }
  R.phase = 'end'; push(R);
}

// ---------- ações vindas dos jogadores ----------
async function handle(b) {
  const pid = String(b.pid || ''); if (!/^[a-z0-9]{8,40}$/.test(pid)) return { err: 'Identificação inválida.' };
  if (b.t === 'create') {
    if (rooms.size >= 200) return { err: 'Servidor cheio, tente mais tarde.' };
    const nm = clean(b.name); if (!nm) return { err: 'Escolha um apelido.' };
    return { code: mkRoom(pid, nm, b.av).code };
  }
  const R = rooms.get(String(b.room || '').toUpperCase().slice(0, 4)); if (!R) return { err: 'Sala não encontrada.' };
  const me = R.players.find(p => p.id === pid);
  if (b.t === 'join') {
    if (me) return { code: R.code };
    if (R.phase !== 'lobby') return { err: 'A partida já começou.' };
    if (R.players.length >= 10) return { err: 'Sala cheia.' };
    const nm = clean(b.name); if (!nm) return { err: 'Escolha um apelido.' };
    let n2 = nm, k = 2; while (R.players.some(p => p.name === n2)) n2 = nm + ' ' + k++;
    addP(R, pid, n2, b.av); push(R); return { code: R.code };
  }
  if (!me) return { err: 'Você não está nesta sala.' };
  const host = R.host === pid;
  switch (b.t) {
    case 'bot': if (!host || R.phase !== 'lobby' || !R.opts.bots || R.players.length >= 10) return {};
      { const used = R.players.map(p => p.name), nm = BOTS.find(x => !used.includes(x)) || 'Bot'; addP(R, 'b' + (++PRN), nm, Math.random() * 6 | 0, true); push(R); } return {};
    case 'rmbot': if (host && R.phase === 'lobby') { R.players = R.players.filter(p => !(p.bot && p.id === b.id)); push(R) } return {};
    case 'opts': if (host && R.phase === 'lobby') { if ('reveal' in b) R.opts.reveal = b.reveal ? 1 : 0; if ('bots' in b) { R.opts.bots = b.bots ? 1 : 0; if (!R.opts.bots) R.players = R.players.filter(p => !p.bot) } push(R) } return {};
    case 'start':
      if (!host || (R.phase !== 'lobby' && R.phase !== 'end')) return { err: 'Só o anfitrião pode começar.' };
      if (R.players.length < 3) return { err: 'São necessários pelo menos 3 jogadores (você pode adicionar computadores).' };
      runGame(R); return {};
    case 'leave': {
      (R.cl.get(pid) || []).forEach(r => r.end()); R.cl.delete(pid);
      if (R.phase !== 'play') R.players = R.players.filter(p => p.id !== pid);
      if (host) { const h = R.players.find(p => !p.bot && isOn(R, p.id)) || R.players.find(p => !p.bot); if (h) R.host = h.id; else { rooms.delete(R.code); return {} } }
      push(R); return {};
    }
    case 'ans': {
      const pr = R.pr[pid]; if (!pr || pr.id !== b.id || !Number.isInteger(b.i) || b.i < 0 || b.i >= pr.n) return {};
      pr.fin(b.i); return {};
    }
  }
  return {};
}

// ---------- HTTP ----------
function events(req, res, u) {
  const R = rooms.get((u.searchParams.get('room') || '').toUpperCase()), pid = u.searchParams.get('pid') || '';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (!R || !R.players.some(p => p.id === pid)) { res.write('event: gone\ndata: 0\n\n'); return res.end() }
  let s = R.cl.get(pid); if (!s) R.cl.set(pid, s = new Set());
  s.add(res); res.write('retry: 2000\n\n'); push(R);
  req.on('close', () => { s.delete(res); if (!s.size && R.cl.get(pid) === s) R.cl.delete(pid); push(R) });
}
function api(req, res) {
  let b = ''; req.on('data', c => { b += c; if (b.length > 4096) req.destroy() });
  req.on('end', async () => {
    let j; try { j = JSON.parse(b) } catch (e) { j = {} }
    let out; try { out = await handle(j) } catch (e) { console.error(e); out = { err: 'Erro no servidor.' } }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };
const PUB = path.join(__dirname, 'public'), cache = new Map();
function sendFile(req, res, file, maxAge) {
  let e = cache.get(file);
  if (!e) {
    let raw; try { raw = fs.readFileSync(file) } catch (x) { res.writeHead(404); return res.end('nao encontrado') }
    const ext = path.extname(file).toLowerCase();
    e = { raw, type: MIME[ext] || 'application/octet-stream', br: ['.svg', '.html'].includes(ext) ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : null };
    cache.set(file, e);
  }
  const h = { 'Content-Type': e.type, 'Cache-Control': maxAge ? 'public, max-age=' + maxAge : 'no-cache', 'Vary': 'Accept-Encoding' };
  if (e.br && /\bbr\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'br'; res.writeHead(200, h); return res.end(e.br) }
  res.writeHead(200, h); res.end(e.raw);
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (u.pathname === '/events') return events(req, res, u);
  if (u.pathname === '/api' && req.method === 'POST') return api(req, res);
  if (u.pathname === '/health') return res.end('ok');
  if (u.pathname.startsWith('/assets/')) {
    let f; try { f = path.normalize(path.join(PUB, decodeURIComponent(u.pathname))) } catch (x) { res.writeHead(400); return res.end() }
    if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end() }
    return sendFile(req, res, f, 604800);
  }
  sendFile(req, res, INDEX, 0);
}).listen(PORT, () => console.log('Sertão no ar na porta ' + PORT));

setInterval(() => { for (const R of rooms.values()) for (const s of R.cl.values()) for (const r of s) r.write(': ping\n\n') }, 20000);
setInterval(() => { const now = Date.now(); for (const [c, R] of rooms) if (!R.cl.size && now - R.seen > (R.phase === 'lobby' ? 30 : 180) * 60000) rooms.delete(c) }, 60000);
