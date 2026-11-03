import { firebaseConfig } from './config.js';
import { FireStore } from './cloud.js';

/* ───────────── defaults ───────────── */
const DEFAULT_SETTINGS = {
  startDate: todayStr().slice(0, 8) + '01',
  startBalance: 0,
  currency: 'AUD',
  categories: ['Groceries', 'Eating out', 'Necessities', 'Entertainment', 'Transport', 'Uber&Lime', 'etc'],
  fixedCats: ['Rent', 'Bill', 'Phone'],
  jobs: [{ id: 'j1', name: 'Job 1', rate: 30, satL: 1.25, sunL: 1.5, otL: 1.5, payg: 0, super: 0.12 }],
  recurring: [],
};
const PALETTE = ['#1f6f5c', '#d97706', '#2563eb', '#be185d', '#7c3aed', '#0891b2', '#65a30d', '#b45309', '#64748b', '#dc2626', '#0d9488', '#9333ea'];
const FIXED_COLOR = '#8b8f97';

/* ───────────── utils ───────────── */
function pad(n) { return String(n).padStart(2, '0'); }
function dstr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return dstr(new Date()); }
function parseD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function ym(s) { return s.slice(0, 7); }
function addMonths(ymStr, k) { const [y, m] = ymStr.split('-').map(Number); const d = new Date(y, m - 1 + k, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function daysInMonth(ymStr) { const [y, m] = ymStr.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function monthName(ymStr) { const [y, m] = ymStr.split('-').map(Number); return `${y}년 ${m}월`; }
const money = (v, sign = false) => {
  const s = Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−$' : (sign && v > 0 ? '+$' : '$')) + s;
};
const money0 = v => money(v); // 모든 금액을 센트 단위까지 표시
const r2 = v => Math.round(v * 100) / 100;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** "12.3+4.5-1" → 15.8 ; returns null if invalid */
function evalAmt(s) {
  s = String(s).replace(/\s|\$|,/g, '');
  if (!s || !/^[-+]?\d*\.?\d+([+-]\d*\.?\d+)*$/.test(s)) return null;
  return r2((s.match(/[-+]?\d*\.?\d+/g) || []).reduce((a, x) => a + parseFloat(x), 0));
}
function payCalc(p) {
  const ord = p.ord * p.rate, sat = p.sat * p.rate * p.satL, sun = p.sun * p.rate * p.sunL, ot = p.ot * p.rate * p.otL;
  const gross = ord + sat + sun + ot, tax = gross * p.payg;
  return { ord, sat, sun, ot, gross: r2(gross), tax: r2(tax), net: r2(gross - tax), sup: r2(gross * p.super) };
}

/* ───────────── stores ───────────── */
class LocalStore {
  constructor() { this.key = 'fin-local-v1'; this.mode = 'local'; }
  _load() { try { return JSON.parse(localStorage.getItem(this.key)) || null; } catch { return null; } }
  _save(d) { try { localStorage.setItem(this.key, JSON.stringify(d)); } catch (e) { toast('저장 실패: ' + e.message); } }
  async start(onData) {
    this.onData = onData;
    this.d = this._load() || { settings: structuredClone(DEFAULT_SETTINGS), tx: {} };
    this.user = { name: '이 기기' };
    onData({ settings: this.d.settings, tx: Object.values(this.d.tx), user: this.user, fresh: !this._load() });
  }
  _emit() { this._save(this.d); this.onData({ settings: this.d.settings, tx: Object.values(this.d.tx), user: this.user }); }
  async saveTx(t) { this.d.tx[t.id] = t; this._emit(); }
  async saveMany(list) { list.forEach(t => this.d.tx[t.id] = t); this._emit(); }
  async deleteTx(id) { delete this.d.tx[id]; this._emit(); }
  async saveSettings(s) { this.d.settings = s; this._emit(); }
  async wipe() { this.d = { settings: structuredClone(DEFAULT_SETTINGS), tx: {} }; this._emit(); }
}

/* ───────────── state ───────────── */
const S = { tab: 'home', month: ym(todayStr()), settings: null, tx: [], user: null, listFilter: 'all', editing: null, kind: 'expense', cat: null, ready: false };
let store;
const $ = s => document.querySelector(s);
const view = $('#view');

function setSync(cls) { const el = $('#syncDot'); el.className = 'sync ' + cls; $('#syncText').textContent = { ok: store?.encrypted ? '동기화됨 · 암호화' : '동기화됨', pending: '업로드 중…', local: '로컬 모드', off: '오프라인' }[cls] || ''; el.title = { ok: '클라우드 동기화됨 (기기에서 암호화)', pending: '변경 사항 업로드 중', local: '로컬 모드 (이 기기에만 저장)', off: '오프라인 — 연결되면 자동 업로드' }[cls] || ''; }
function toast(msg, ms = 2200, action) {
  const t = $('#toast'); t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-act">${esc(action.label)}</button>` : ''}`; t.hidden = false;
  if (action) t.querySelector('.toast-act').onclick = () => { t.hidden = true; action.fn(); };
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, action ? Math.max(ms, 5000) : ms);
}
/** 저장·삭제 후 5초간 '되돌리기' 버튼 */
function undoable(msg, undoFn) { toast(msg, 5000, { label: '되돌리기', fn: async () => { await undoFn(); toast('되돌렸어요'); } }); }
/** 최근 90일 동안 3번 이상 같은 카테고리·금액으로 쓴 지출 = 자주 쓰는 항목 */
function favorites(n = 8) {
  const since = dstr(new Date(Date.now() - 90 * 864e5)), cnt = {};
  for (const t of S.tx) if (t.kind === 'expense' && t.date >= since && t.amount > 0) { const k = t.cat + '|' + t.amount; cnt[k] = (cnt[k] || 0) + 1; }
  return Object.entries(cnt).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, c]) => { const i = k.lastIndexOf('|'); return { cat: k.slice(0, i), amount: +k.slice(i + 1), count: c }; })
    .filter(f => S.settings.categories.includes(f.cat));
}
function favHTML() {
  const f = favorites(); if (!f.length) return '';
  return `<div class="fav-row"><span class="fav-lbl">자주 쓰는 항목 · 한 번 누르면 바로 저장</span>${f.map(x => `<button type="button" class="fav" data-fav="${esc(x.cat)}|${x.amount}" title="최근 90일 ${x.count}회"><i style="background:${colorOf(x.cat)}"></i>${esc(x.cat)} <b>${money(x.amount)}</b></button>`).join('')}</div>`;
}
async function addFav(el, date) {
  const v = el.dataset.fav, i = v.lastIndexOf('|'), t = { id: uid(), ts: Date.now(), date: date || todayStr(), kind: 'expense', cat: v.slice(0, i), amount: +v.slice(i + 1), memo: '' };
  await store.saveTx(t);
  undoable(`${+t.date.slice(5, 7)}/${+t.date.slice(8)} ${t.cat} ${money(t.amount)} 저장됨`, () => store.deleteTx(t.id));
}

function colorOf(cat) {
  const s = S.settings; const i = s.categories.indexOf(cat);
  if (i >= 0) return PALETTE[i % PALETTE.length];
  return s.fixedCats.includes(cat) ? FIXED_COLOR : '#94a3b8';
}

/* ───────────── recurring fixed costs ───────────── */
function nextDate(rule, fromStr) {
  const d = parseD(fromStr);
  if (rule.freq === 'weekly') { d.setDate(d.getDate() + 7); return dstr(d); }
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const nm = new Date(y, m, 1); const dim = new Date(nm.getFullYear(), nm.getMonth() + 1, 0).getDate();
  return dstr(new Date(nm.getFullYear(), nm.getMonth(), Math.min(rule.dom, dim)));
}
async function runRecurring() {
  const s = structuredClone(S.settings); if (!s.recurring?.length) return;
  const today = todayStr(); const add = []; let changed = false;
  const existing = new Set(S.tx.map(t => t.id));
  for (const r of s.recurring) {
    let guard = 0;
    while (r.next && r.next <= today && guard++ < 120) {
      const id = `rec-${r.id}-${r.next}`;
      if (!existing.has(id)) add.push({ id, date: r.next, kind: 'fixed', cat: r.cat, amount: r.amount, memo: r.memo || '', auto: true });
      r.next = nextDate(r, r.next); changed = true;
    }
  }
  if (add.length) await store.saveMany(add);
  if (changed) await store.saveSettings(s);
  if (add.length) toast(`고정비 ${add.length}건 자동 등록`);
}
function upcomingFixed(month) {
  const today = todayStr(); let sum = 0; const end = month + '-' + pad(daysInMonth(month));
  for (const r of S.settings.recurring || []) {
    let d = r.next, g = 0;
    while (d && d <= end && g++ < 40) { if (d > today && ym(d) === month) sum += r.amount; d = nextDate(r, d); }
  }
  return r2(sum);
}

/* ───────────── calculations ───────────── */
function monthTx(month) { return S.tx.filter(t => ym(t.date) === month); }
function sums(list) {
  const o = { expense: 0, fixed: 0, income: 0, byCat: {} };
  for (const t of list) { o[t.kind] += t.amount; if (t.kind !== 'income') o.byCat[t.cat] = (o.byCat[t.cat] || 0) + t.amount; }
  o.spend = o.expense + o.fixed; return o;
}
function balanceThrough(dateStr) {
  const s = S.settings; let b = +s.startBalance || 0;
  for (const t of S.tx) if (t.date >= s.startDate && t.date <= dateStr) b += t.kind === 'income' ? t.amount : -t.amount;
  return r2(b);
}
function openingOf(month) { const prevEnd = addMonths(month, 0) + '-00'; return balanceThrough(prevEnd); }

/* ───────────── views ───────────── */
function render() {
  $('#monthLabel').textContent = monthName(S.month);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#fab').hidden = !S.ready || S.tab === 'settings';
  $('.top').style.visibility = S.ready && S.tab !== 'settings' ? 'visible' : 'hidden';
  $('#todayM').hidden = S.month === ym(todayStr());
  document.body.classList.toggle('wide', wide());
  document.body.classList.toggle('locked', !S.ready);
  if (!S.ready) return;
  ({ home: renderHome, list: renderList, income: renderIncome, settings: renderSettings })[S.tab]();
}

const mq = window.matchMedia('(min-width: 960px)');
const wide = () => mq.matches;
const WD = ['일', '월', '화', '수', '목', '금', '토'];

function renderHome() {
  const m = S.month, s = sums(monthTx(m)), today = todayStr(), curM = ym(today);
  const opening = openingOf(m), remain = r2(opening + s.income - s.spend);
  let hero;
  let free = null;
  if (m === curM) {
    const w = weekPace(), mp = monthPace();
    free = freeMoney();
    hero = `<div class="card hero a-hero pace-card"><div class="h2">지출 페이스 <span class="label">변동비 기준 · 같은 시점끼리 비교</span></div>
      ${paceRow('이번 주', `${+w.start.slice(5, 7)}/${+w.start.slice(8)}(월)~오늘 · ${w.k}일째`, w.cur, w.avgTo, w.avgFull, w.n, '주')}
      ${paceRow('이번 달', `${parseD(today).getDate()}일째`, mp.cur, mp.avgTo, mp.avgFull, mp.n, '달')}</div>`;
  } else if (m < curM) {
    hero = `<div class="card hero a-hero"><div class="label">월말 잔고</div><div class="big num ${remain < 0 ? 'neg' : ''}">${money(remain)}</div>
      <div class="note">이 달 저축 ${money(s.income - s.spend, true)}${s.income ? ` (${Math.round((s.income - s.spend) / s.income * 100)}%)` : ''}</div></div>`;
  } else {
    hero = `<div class="card hero a-hero"><div class="label">예상 시작 잔고</div><div class="big num">${money(opening)}</div><div class="note">아직 시작하지 않은 달이에요</div></div>`;
  }
  const pm = addMonths(m, -1), cut = m === curM ? pm + '-' + pad(Math.min(parseD(today).getDate(), daysInMonth(pm))) : pm + '-31';
  const prev = sums(monthTx(pm).filter(t => t.date <= cut));
  const known = [...S.settings.categories, ...S.settings.fixedCats];
  const cats = [...known, ...Object.keys(s.byCat).filter(c => !known.includes(c))];
  const max = Math.max(1, ...cats.map(c => s.byCat[c] || 0));
  const bud = S.settings.budgets || {};
  const pace = m === curM ? parseD(today).getDate() / daysInMonth(m) : m < curM ? 1 : 0;
  const rows = cats.filter(c => s.byCat[c] || bud[c]).sort((a, b) => (s.byCat[b] || 0) - (s.byCat[a] || 0)).map(c => {
    const v = s.byCat[c] || 0, d = v - (prev.byCat[c] || 0), b = bud[c];
    if (b) {
      const over = v > b, ahead = !over && v > b * pace * 1.1;
      return `<div class="bar-row budget ${over ? 'over' : ahead ? 'ahead' : ''}"><span class="name">${esc(c)}</span>
        <div class="bar"><i style="width:${Math.min(v / b, 1) * 100}%;background:${over ? 'var(--warn)' : colorOf(c)}"></i>${pace > 0 && pace < 1 ? `<s style="left:${pace * 100}%" title="오늘까지 적정 사용량"></s>` : ''}</div>
        <span class="amt num">${money0(v)}<span class="delta">/ ${money0(b)} · ${over ? `${money0(v - b)} 초과` : `${money0(b - v)} 남음`}</span></span>${wide() ? `<span class="pct num">${Math.round(v / b * 100)}%</span>` : ''}</div>`;
    }
    return `<div class="bar-row"><span class="name">${esc(c)}</span><div class="bar"><i style="width:${v / max * 100}%;background:${colorOf(c)}"></i></div>
      <span class="amt num">${money0(v)}<span class="delta">${d >= 0 ? '▲' : '▼'}${money0(Math.abs(d))}</span></span>${wide() ? `<span class="pct num">${s.spend ? Math.round(v / s.spend * 100) : 0}%</span>` : ''}</div>`;
  }).join('');
  const months = Array.from({ length: 6 }, (_, i) => addMonths(m, i - 5));
  const ms = months.map(x => ({ x, ...sums(monthTx(x)) }));
  const tmax = Math.max(1, ...ms.map(o => o.spend));
  const trend = ms.map(o => `<button class="col ${o.x === m ? 'cur' : ''}" data-goto="${o.x}" title="${monthName(o.x)}: 변동비 ${money(o.expense)} · 고정비 ${money(o.fixed)} · 수입 ${money(o.income)}"><span class="t num">${o.spend ? money0(o.spend) : ''}</span>
    <div class="stack" style="height:${o.spend / tmax * 85}%"><i style="flex:${o.expense};background:var(--accent)"></i><i style="flex:${o.fixed};background:${FIXED_COLOR}"></i></div>
    <span class="m">${+o.x.slice(5)}월</span></button>`).join('');
  let recent;
  if (wide()) {
    const list = monthTx(m).sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0)).slice(0, 10);
    recent = `<div class="card a-recent"><div class="h2">최근 기록 <button class="link" data-tab-go="list">전체 보기 →</button></div>${list.length ? tableHTML(list) : '<div class="empty">이 달 기록이 없어요</div>'}</div>`;
  } else if (m === curM) {
    const todays = S.tx.filter(t => t.date === today);
    recent = `<div class="card a-recent"><div class="h2">오늘 <span class="label num">${money(todays.filter(t => t.kind !== 'income').reduce((a, t) => a + t.amount, 0))}</span></div>${todays.length ? todays.map(itemHTML).join('') : '<div class="empty">오늘 기록이 없어요. + 버튼으로 추가</div>'}</div>`;
  } else recent = '';
  view.innerHTML = `<div class="home-grid">${hero}
    <div class="stats a-stats ${free ? 'n4' : 'n3'}">
      <div class="stat"><div class="label">지출</div><div class="v num">${money0(s.spend)}</div><div class="sub small">변동 ${money0(s.expense)} · 고정 ${money0(s.fixed)}</div></div>
      <div class="stat"><div class="label">수입</div><div class="v num">${money0(s.income)}</div><div class="sub small">${s.income ? `저축률 ${Math.round((s.income - s.spend) / s.income * 100)}%` : '&nbsp;'}</div></div>
      <div class="stat budget"><div class="label">Budget${m < curM ? ' (월말)' : ''}</div><div class="v num ${remain < 0 ? 'neg' : ''}">${money(remain)}</div><div class="sub small">월초 ${money(opening)} + 수입 − 지출</div></div>
      ${free ? `<button class="stat free" id="freeTile"><div class="label">실제 여유 돈 ⓘ</div><div class="v num ${free.value < 0 ? 'neg' : ''}">${money(free.value)}</div><div class="sub small">Budget − ${free.untilLabel} 고정비 ${money(free.fixed)}</div></button>` : ''}
    </div>
    ${wide() ? quickHTML() : ''}
    <div class="card a-cats"><div class="h2">카테고리별 <span class="label">${Object.keys(bud).length ? '예산 있는 항목은 사용/예산 · ' : ''}${m === curM ? '▲▼ 지난달 같은 날짜까지 대비' : '▲▼ 지난달 대비'}</span></div>${rows || '<div class="empty">이 달 지출이 없어요</div>'}</div>
    <div class="card a-trend"><div class="h2">최근 6개월 지출</div><div class="trend">${trend}</div>
      <div class="legend"><span><i style="background:var(--accent)"></i>변동비</span><span><i style="background:${FIXED_COLOR}"></i>고정비</span></div></div>
    ${reportHTML(m)}
    ${recent}</div>`;
  view.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { S.month = b.dataset.goto; render(); });
  $('#freeTile') && ($('#freeTile').onclick = () => alertBox(freeExplain(free)));
  view.querySelectorAll('[data-tab-go]').forEach(b => b.onclick = () => { S.tab = b.dataset.tabGo; render(); });
  bindItems(); bindQuick();
}

/* ───── 페이스 · 실제 여유 돈 ───── */
const varIn = (a, b) => S.tx.reduce((x, t) => x + (t.kind === 'expense' && t.date >= a && t.date <= b ? t.amount : 0), 0);
const addDays = (d, k) => { const x = parseD(d); x.setDate(x.getDate() + k); return dstr(x); };
const firstDate = () => S.tx.reduce((a, t) => t.date < a ? t.date : a, '9999');
function weekPace() {
  const today = todayStr(), dow = (parseD(today).getDay() + 6) % 7, start = addDays(today, -dow), k = dow + 1, fd = firstDate();
  const weeks = [];
  for (let i = 1; i <= 8; i++) { const ws = addDays(start, -7 * i); if (ws >= fd) weeks.push(ws); }
  const n = weeks.length;
  return { start, k, cur: varIn(start, today), n,
    avgTo: n ? weeks.reduce((a, ws) => a + varIn(ws, addDays(ws, k - 1)), 0) / n : null,
    avgFull: n ? weeks.reduce((a, ws) => a + varIn(ws, addDays(ws, 6)), 0) / n : null };
}
function monthPace() {
  const today = todayStr(), m = ym(today), d = parseD(today).getDate(), fd = firstDate();
  const ms = [1, 2, 3].map(i => addMonths(m, -i)).filter(x => x + '-01' >= fd);
  const n = ms.length;
  return { cur: varIn(m + '-01', today), n,
    avgTo: n ? ms.reduce((a, x) => a + varIn(x + '-01', x + '-' + pad(Math.min(d, daysInMonth(x)))), 0) / n : null,
    avgFull: n ? ms.reduce((a, x) => a + varIn(x + '-01', x + '-31'), 0) / n : null };
}
function paceRow(title, sub, cur, avgTo, avgFull, n, unit) {
  if (avgTo === null) return `<div class="pace"><div class="pace-top"><b>${title}</b><span class="num big2">${money(cur)}</span></div><div class="small">비교할 과거 기록이 아직 없어요</div></div>`;
  const diff = cur - avgTo, scale = Math.max(cur, avgFull, 1), cls = diff > avgTo * 0.1 + 5 ? 'hi' : diff < -(avgTo * 0.1 + 5) ? 'lo' : 'eq';
  const word = cls === 'hi' ? `평소보다 ${money0(diff)} 많이 씀` : cls === 'lo' ? `평소보다 ${money0(-diff)} 덜 씀` : '평소와 비슷';
  return `<div class="pace ${cls}"><div class="pace-top"><span><b>${title}</b> <span class="small">${sub}</span></span><span class="num big2">${money(cur)}</span></div>
    <div class="pbar"><i style="width:${cur / scale * 100}%"></i><s style="left:${avgTo / scale * 100}%" title="평소 이맘때"></s><u style="left:${Math.min(avgFull / scale, 1) * 100}%" title="평소 한 ${unit} 전체"></u></div>
    <div class="pace-bot"><span class="verdict">${word}</span><span class="small">평소 이맘때 ${money0(avgTo)} · 한 ${unit} 평균 ${money0(avgFull)} (최근 ${n}${unit === '주' ? '주' : '개월'})</span></div></div>`;
}
/** 지금 잔고 − (다음 페이일 전 / 페이일 미설정 시 이번 달 말까지) 나갈 반복 고정비 */
function freeMoney() {
  const today = todayStr(), m = ym(today), ms = sums(monthTx(m)), bal = r2(openingOf(m) + ms.income - ms.spend); // = 이번 달 Budget
  const pays = getJobs().map(j => payDate(j, 1, addDays(today, 1))).filter(Boolean).sort();
  const until = pays[0] ? addDays(pays[0], -1) : ym(today) + '-' + pad(daysInMonth(ym(today)));
  const items = [];
  for (const r of S.settings.recurring || []) { let d = r.next, g = 0; while (d && d <= until && g++ < 60) { if (d > today) items.push({ d, cat: r.cat, amount: r.amount }); d = nextDate(r, d); } }
  items.sort((a, b) => a.d.localeCompare(b.d));
  const fixed = r2(items.reduce((a, x) => a + x.amount, 0));
  return { bal, fixed, value: r2(bal - fixed), items, payday: pays[0] || null, until,
    untilLabel: pays[0] ? `${+pays[0].slice(5, 7)}/${+pays[0].slice(8)} 페이일 전` : '이번 달 남은' };
}
function freeExplain(f) {
  const s = S.settings;
  return `<h3>실제 여유 돈 = ${money(f.value)}</h3>
    <div class="calc"><span class="k">Budget (월초 + 수입 − 지출)</span><span class="v num">${money(f.bal)}</span>
    ${f.items.map(x => `<span class="k">− ${+x.d.slice(5, 7)}/${+x.d.slice(8)} ${esc(x.cat)}</span><span class="v num">−${money(x.amount)}</span>`).join('')}
    <span class="k tot">여유 돈</span><span class="v tot num">${money(f.value)}</span></div>
    <p class="p"><b>Budget</b>은 엑셀과 같은 방식이에요: 이번 달 월초 금액 + 이번 달 수입 − 이번 달 지출. 월초 금액은 ${s.startDate} 시작 잔고 ${money(s.startBalance)}부터 매달 이월된 값이에요. 실제 은행 잔고와 다르면 설정의 잔고 기준점을 맞춰 주세요.</p>
    <p class="p"><b>실제 여유 돈</b>은 Budget에서 아직 안 나갔지만 곧 나갈 반복 고정비를 뺀 값이에요.</p>
    <p class="p">${f.payday ? `다음 페이일 ${f.payday} 전날까지 자동 등록될 반복 고정비를 뺐어요.` : '직장 페이일이 설정되지 않아 이번 달 말까지 나갈 반복 고정비를 뺐어요. 설정 → 직장에서 페이 주기를 넣으면 다음 페이일 기준으로 바뀌어요.'} 반복 고정비로 등록하지 않은 지출(전기·가스 등)은 포함되지 않아요.</p>`;
}
function alertBox(html) {
  let d = $('#infoBox');
  if (!d) { d = document.createElement('div'); d.id = 'infoBox'; d.className = 'sheet'; document.body.appendChild(d); }
  d.innerHTML = `<div class="sheet-bg"></div><div class="sheet-card">${html}<div class="sheet-actions"><button class="primary">확인</button></div></div>`;
  d.hidden = false; d.querySelectorAll('.sheet-bg,.primary').forEach(x => x.onclick = () => d.hidden = true);
}

/* 월간 리포트: 계산 가능한 사실만 */
function reportHTML(m) {
  const today = todayStr(), curM = ym(today);
  if (m > curM) return '';
  const list = monthTx(m), exp = list.filter(t => t.kind === 'expense');
  const days = m === curM ? parseD(today).getDate() : daysInMonth(m);
  const spentDays = new Set(exp.filter(t => t.amount > 0).map(t => t.date));
  const noSpend = Array.from({ length: days }, (_, i) => m + '-' + pad(i + 1)).filter(d => !spentDays.has(d)).length;
  const s = sums(list), varSum = s.expense;
  const big = exp.slice().sort((a, b) => b.amount - a.amount)[0];
  const pm = addMonths(m, -1), cut = m === curM ? pm + '-' + pad(Math.min(days, daysInMonth(pm))) : pm + '-31';
  const ps = sums(monthTx(pm).filter(t => t.date <= cut && t.kind === 'expense'));
  const diffs = S.settings.categories.map(c => [c, (s.byCat[c] || 0) - (ps.byCat[c] || 0)]).filter(([, d]) => Math.abs(d) >= 1).sort((a, b) => b[1] - a[1]);
  const up = diffs[0]?.[1] > 0 ? diffs[0] : null, down = diffs.at(-1)?.[1] < 0 ? diffs.at(-1) : null;
  const top = S.settings.categories.map(c => [c, s.byCat[c] || 0]).sort((a, b) => b[1] - a[1])[0];
  const tiles = [
    ['하루 평균 변동비', money(varSum / days), `${days}일 기준`],
    ['무지출일', `${noSpend}일`, `${days}일 중 변동비 0원인 날`],
    ['가장 많이 쓴 항목', top && top[1] ? esc(top[0]) : '—', top && top[1] ? `${money(top[1])} · 변동비의 ${Math.round(top[1] / varSum * 100)}%` : ''],
    ['가장 큰 한 건', big ? money(big.amount) : '—', big ? `${+big.date.slice(5, 7)}/${+big.date.slice(8)} ${esc(big.cat)}${big.memo ? ' · ' + esc(big.memo) : ''}` : ''],
    ['지난달보다 늘어난 항목', up ? esc(up[0]) : '없음', up ? `+${money(up[1])}` : ''],
    ['지난달보다 줄어든 항목', down ? esc(down[0]) : '없음', down ? `−${money(-down[1])}` : ''],
  ];
  return `<div class="card a-report"><div class="h2">${+m.slice(5)}월 리포트 <span class="label">${m === curM ? '오늘까지 기준 · 비교는 지난달 같은 날짜까지' : '지난달 전체와 비교'}</span></div>
    <div class="tiles">${tiles.map(([k, v, sub]) => `<div class="tile"><div class="label">${k}</div><div class="tv num">${v}</div><div class="small">${sub || '&nbsp;'}</div></div>`).join('')}</div></div>`;
}

/* desktop table */
function tableHTML(list, showDate = true) {
  return `<table class="tbl"><thead><tr>${showDate ? '<th>날짜</th>' : ''}<th>카테고리</th><th>메모</th><th>구분</th><th class="r">금액</th></tr></thead><tbody>${list.map(t => {
    const inc = t.kind === 'income';
    return `<tr class="item-row" data-id="${esc(t.id)}">${showDate ? `<td class="num muted">${+t.date.slice(5, 7)}/${+t.date.slice(8)} (${WD[parseD(t.date).getDay()]})</td>` : ''}
      <td><span class="dot" style="background:${inc ? 'var(--good)' : colorOf(t.cat)}"></span>${esc(t.cat)}</td>
      <td class="muted">${esc([t.memo, t.expr ? t.expr : '', t.pay ? `${t.pay.ord + t.pay.sat + t.pay.sun + t.pay.ot}시간` : ''].filter(Boolean).join(' · '))}</td>
      <td><span class="tag">${inc ? (t.src || '수입') : t.kind === 'fixed' ? (t.auto ? '고정·자동' : '고정비') : '지출'}</span></td>
      <td class="r num ${inc ? 'pos' : ''}"><b>${inc ? '+' : ''}${money(t.amount)}</b></td></tr>`;
  }).join('')}</tbody></table>`;
}

/* desktop quick-add bar */
const QK = { kind: 'expense', cat: null, date: null };
function quickHTML() {
  const cats = catsFor(QK.kind); if (!cats.includes(QK.cat)) QK.cat = cats[0];
  const d = QK.date && ym(QK.date) === S.month ? QK.date : (S.month === ym(todayStr()) ? todayStr() : S.month + '-01');
  return `<form class="card quick a-quick" id="quick" autocomplete="off">
    <div class="seg small-seg">${[['expense', '지출'], ['fixed', '고정비'], ['income', '수입']].map(([k, n]) => `<button type="button" data-qk="${k}" class="${QK.kind === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="q-amt"><span>$</span><input id="qAmt" placeholder="금액 (12.3+4.5 가능)"><em id="qSum"></em></div>
    <select id="qCat">${cats.map(c => `<option ${c === QK.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <input id="qDate" type="date" value="${d}">
    <input id="qMemo" placeholder="메모 (선택)">
    <button class="primary" type="submit">추가 <kbd>Enter</kbd></button>
    ${QK.kind === 'expense' ? favHTML() : ''}
  </form>`;
}
function bindQuick() {
  const f = $('#quick'); if (!f) return;
  f.querySelectorAll('[data-qk]').forEach(b => b.onclick = () => { QK.kind = b.dataset.qk; QK.cat = null; render(); $('#qAmt')?.focus(); });
  $('#qAmt').oninput = () => { const v = $('#qAmt').value, x = evalAmt(v); $('#qSum').textContent = /[+-]/.test(v.replace(/^-/, '')) ? (x === null ? '?' : '= ' + money(x)) : ''; };
  $('#qCat').onchange = () => QK.cat = $('#qCat').value;
  f.querySelectorAll('[data-fav]').forEach(b => b.onclick = () => addFav(b, $('#qDate').value));
  $('#qDate').onchange = () => QK.date = $('#qDate').value;
  f.onsubmit = async e => {
    e.preventDefault();
    const raw = $('#qAmt').value, amt = evalAmt(raw);
    if (amt === null || amt === 0) { toast('금액을 확인해 주세요'); return $('#qAmt').focus(); }
    const date = $('#qDate').value || todayStr(), cat = $('#qCat').value, memo = $('#qMemo').value.trim();
    QK.date = date; QK.cat = cat;
    const t = { id: uid(), ts: Date.now(), date, kind: QK.kind, amount: amt, memo };
    if (/\+|.-/.test(raw.replace(/\s/g, ''))) t.expr = raw.replace(/\s/g, '');
    if (QK.kind === 'income') { t.src = cat; t.cat = cat === 'KR' ? 'KR 송금' : 'AU 수입'; } else t.cat = cat;
    document.activeElement?.blur();
    await store.saveTx(t);
    render();
    undoable(`저장됨 · ${t.cat} ${money(amt)}`, () => store.deleteTx(t.id));
    setTimeout(() => $('#qAmt')?.focus(), 30);
  };
}

function itemHTML(t) {
  const isInc = t.kind === 'income';
  const sub = [t.memo, t.kind === 'fixed' ? '고정비' : '', t.auto ? '자동' : '', t.pay ? `${t.pay.ord + t.pay.sat + t.pay.sun + t.pay.ot}시간` : ''].filter(Boolean).join(' · ');
  return `<button class="item" data-id="${esc(t.id)}"><span class="dot" style="background:${isInc ? 'var(--good)' : colorOf(t.cat)}"></span>
    <span class="c"><b>${esc(t.cat)}</b>${isInc && t.src ? `<span class="tag" style="display:inline">${esc(t.src)}</span>` : ''}${sub ? `<span>${esc(sub)}</span>` : ''}</span>
    <span class="a num ${isInc ? 'pos' : ''}">${isInc ? '+' : ''}${money(t.amount)}</span></button>`;
}
function bindItems() { view.querySelectorAll('[data-id]').forEach(b => b.onclick = () => openSheet(S.tx.find(t => t.id === b.dataset.id))); }

function calHTML(m, list) {
  const dim = daysInMonth(m), first = parseD(m + '-01').getDay(), today = todayStr();
  const by = {}; for (const t of list) { const o = by[t.date] ||= { v: 0, f: 0, i: 0 }; if (t.kind === 'expense') o.v += t.amount; else if (t.kind === 'fixed') o.f += t.amount; else o.i += t.amount; }
  const max = Math.max(1, ...Object.values(by).map(o => o.v));
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<span class="cd empty-cd"></span>');
  for (let d = 1; d <= dim; d++) {
    const ds = m + '-' + pad(d), o = by[ds], v = o?.v || 0, lvl = v ? Math.max(.12, v / max) : 0;
    cells.push(`<button class="cd ${ds === S.selDay ? 'sel' : ''} ${ds === today ? 'today' : ''} ${ds > today ? 'future' : ''}" data-day="${ds}" style="--lvl:${Math.round(lvl * 55)}%">
      <span class="dn">${d}</span>${v ? `<span class="dv num">${money0(v)}</span>` : ''}<span class="dots">${o?.f ? '<i class="df" title="고정비"></i>' : ''}${o?.i ? '<i class="di" title="수입"></i>' : ''}</span></button>`);
  }
  return `<div class="card cal"><div class="cal-h">${WD.map(w => `<span>${w}</span>`).join('')}</div><div class="cal-g">${cells.join('')}</div>
    <div class="legend"><span>칸 색이 진할수록 변동비가 많은 날</span><span><i class="df"></i>고정비</span><span><i class="di"></i>수입</span></div></div>`;
}

function renderList() {
  const list = monthTx(S.month);
  const cats = ['all', 'income', 'fixed', ...S.settings.categories];
  const f = S.listFilter, q = (S.q || '').toLowerCase(), cal = S.listView === 'cal';
  if (S.selDay && ym(S.selDay) !== S.month) S.selDay = null;
  const filtered = list.filter(t => f === 'all' || (f === 'income' ? t.kind === 'income' : f === 'fixed' ? t.kind === 'fixed' : t.cat === f && t.kind === 'expense'))
    .filter(t => !q || (t.cat + ' ' + (t.memo || '') + ' ' + t.amount).toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0));
  const shown = cal && S.selDay ? filtered.filter(t => t.date === S.selDay) : filtered;
  const total = shown.reduce((a, t) => a + (t.kind === 'income' ? 0 : t.amount), 0);
  const inc = shown.reduce((a, t) => a + (t.kind === 'income' ? t.amount : 0), 0);
  const toggle = `<div class="seg view-seg"><button data-lv="list" class="${cal ? '' : 'on'}">목록</button><button data-lv="cal" class="${cal ? 'on' : ''}">달력</button></div>`;
  const filters = `<div class="filters">${cats.map(c => `<button class="chip ${f === c ? 'on' : ''}" data-f="${esc(c)}">${{ all: '전체', income: '수입', fixed: '고정비' }[c] || esc(c)}</button>`).join('')}</div>`;
  const summary = `${cal && S.selDay ? `<b>${+S.selDay.slice(5, 7)}/${+S.selDay.slice(8)} (${WD[parseD(S.selDay).getDay()]})</b> <button class="link" id="clrDay">전체 보기</button> · ` : ''}${shown.length}건 · 지출 ${money(total)}${inc ? ` · 수입 ${money(inc)}` : ''}`;
  const calBlock = cal ? calHTML(S.month, filtered) : '';
  if (wide()) {
    view.innerHTML = `${quickHTML()}<div class="list-head">${toggle}${filters}<input id="q" class="search" placeholder="검색 (메모·카테고리·금액)" value="${esc(S.q || '')}"></div>
      ${calBlock}<div class="small" style="margin:0 2px 8px">${summary}</div>
      <div class="card" style="padding:4px 8px">${shown.length ? tableHTML(shown) : '<div class="empty">기록이 없어요</div>'}</div>`;
    $('#q').oninput = e => { S.q = e.target.value; const pos = e.target.selectionStart; renderList(); const i = $('#q'); i.focus(); i.setSelectionRange(pos, pos); };
    bindQuick();
  } else {
    const byDay = {}; shown.forEach(t => (byDay[t.date] ||= []).push(t));
    view.innerHTML = `<div class="list-head">${toggle}</div>${filters}${calBlock}<div class="small" style="margin:0 2px 6px">${summary}</div>
    ${Object.keys(byDay).length ? Object.entries(byDay).map(([d, ts]) => {
      const sp = ts.filter(t => t.kind !== 'income').reduce((a, t) => a + t.amount, 0);
      return `<div class="day"><div class="day-h"><span>${+d.slice(8)}일 (${WD[parseD(d).getDay()]})</span><span class="num">${sp ? money(sp) : ''}</span></div><div class="card" style="padding:4px 12px">${ts.map(itemHTML).join('')}</div></div>`;
    }).join('') : '<div class="empty">기록이 없어요</div>'}`;
  }
  view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.listFilter = b.dataset.f; render(); });
  view.querySelectorAll('[data-lv]').forEach(b => b.onclick = () => { S.listView = b.dataset.lv; S.selDay = null; render(); });
  view.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { S.selDay = S.selDay === b.dataset.day ? null : b.dataset.day; render(); });
  $('#clrDay') && ($('#clrDay').onclick = () => { S.selDay = null; render(); });
  bindItems();
}

const JOB_DEFAULT = { rate: 30, satL: 1.25, sunL: 1.5, otL: 1.5, payg: 0, super: 0.12 };
function getJobs() {
  const s = S.settings;
  return s.jobs?.length ? s.jobs : [{ id: 'j1', name: '기본 직장', ...JOB_DEFAULT, ...(s.pay || {}) }];
}
function normalizeSettings(raw = {}) {
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...raw };
  if (!raw.jobs?.length) s.jobs = raw.pay ? [{ id: 'j1', name: '기본 직장', ...JOB_DEFAULT, ...raw.pay }] : structuredClone(DEFAULT_SETTINGS.jobs);
  delete s.pay;
  return s;
}
const jobOf = t => t.pay?.jobId || 'j1';
const FREQ_N = { weekly: '매주', fortnightly: '2주마다', monthly: '매월' };
/** 페이일 계산: dir=+1 → 오늘 이후(오늘 포함) 다음 페이일, dir=-1 → 오늘 이전(오늘 포함) 최근 페이일 */
function payDate(j, dir = 1, from = todayStr()) {
  if (!j.freq) return null;
  const t = parseD(from);
  if (j.freq === 'monthly') {
    const at = (y, m) => new Date(y, m, Math.min(j.payDom || 1, new Date(y, m + 1, 0).getDate()));
    let d = at(t.getFullYear(), t.getMonth());
    if (dir > 0 && d < t) d = at(t.getFullYear(), t.getMonth() + 1);
    if (dir < 0 && d > t) d = at(t.getFullYear(), t.getMonth() - 1);
    return dstr(d);
  }
  if (j.freq === 'weekly') {
    const diff = ((j.payDow ?? 4) - t.getDay() + 7) % 7;
    const d = new Date(t); d.setDate(d.getDate() + (dir > 0 ? diff : (diff ? diff - 7 : 0))); return dstr(d);
  }
  if (!j.anchor) return null; // fortnightly
  const a = parseD(j.anchor), days = Math.round((t - a) / 864e5), k = dir > 0 ? Math.ceil(days / 14) : Math.floor(days / 14);
  const d = new Date(a); d.setDate(d.getDate() + k * 14); return dstr(d);
}
const dday = d => { const n = Math.round((parseD(d) - parseD(todayStr())) / 864e5); return n === 0 ? '오늘' : n > 0 ? `D-${n}` : `${-n}일 전`; };
const lastSlip = jobId => S.tx.filter(t => t.pay && jobOf(t) === jobId).sort((a, b) => b.date.localeCompare(a.date))[0];
const payDraft = { date: todayStr(), ord: '', sat: '', sun: '', ot: '', jobId: null };
function renderIncome() {
  const jobs = getJobs();
  if (!jobs.find(j => j.id === payDraft.jobId)) payDraft.jobId = jobs[0].id;
  const p = jobs.find(j => j.id === payDraft.jobId);
  if (!payDraft.dateTouched) payDraft.date = payDate(p, -1) || todayStr();
  const list = monthTx(S.month).filter(t => t.kind === 'income').sort((a, b) => b.date.localeCompare(a.date));
  const kr = list.filter(t => t.src === 'KR').reduce((a, t) => a + t.amount, 0), au = list.filter(t => t.src !== 'KR').reduce((a, t) => a + t.amount, 0);
  const slips = list.filter(t => t.pay);
  const perJob = jobs.map(j => {
    const ts = slips.filter(t => jobOf(t) === j.id);
    return { j, n: ts.length, hrs: ts.reduce((a, t) => a + t.pay.ord + t.pay.sat + t.pay.sun + t.pay.ot, 0), net: ts.reduce((a, t) => a + t.amount, 0) };
  }).filter(o => o.n);
  view.innerHTML = `
    <div class="stats" style="grid-template-columns:1fr 1fr 1fr">
      <div class="stat"><div class="label">총 수입</div><div class="v num">${money0(kr + au)}</div></div>
      <div class="stat"><div class="label">AU</div><div class="v num">${money0(au)}</div></div>
      <div class="stat"><div class="label">KR</div><div class="v num">${money0(kr)}</div></div>
    </div>
    <div class="two-col"><div class="card"><div class="h2">주급 계산 <span class="label num">시급 ${money(p.rate)}</span></div>
      <div class="filters" style="flex-wrap:wrap">${jobs.map(j => `<button class="chip ${j.id === p.id ? 'on' : ''}" data-job="${esc(j.id)}">${esc(j.name)}</button>`).join('')}<button class="chip" id="addJobGo">+ 직장</button></div>
      <div class="form-grid">
        <label style="grid-column:1/-1">지급일<input type="date" id="pDate" value="${payDraft.date}"></label>
        <label>평일 시간<input inputmode="decimal" id="pOrd" value="${payDraft.ord}" placeholder="0"></label>
        <label>토요일 시간 ×${p.satL}<input inputmode="decimal" id="pSat" value="${payDraft.sat}" placeholder="0"></label>
        <label>일요일 시간 ×${p.sunL}<input inputmode="decimal" id="pSun" value="${payDraft.sun}" placeholder="0"></label>
        <label>초과근무 ×${p.otL}<input inputmode="decimal" id="pOt" value="${payDraft.ot}" placeholder="0"></label>
      </div>
      ${lastSlip(p.id) ? `<button class="link" id="pLast" style="margin-top:8px">↺ 지난번 시간 불러오기 (${(() => { const l = lastSlip(p.id).pay; return ['평일 ' + l.ord, l.sat ? '토 ' + l.sat : '', l.sun ? '일 ' + l.sun : '', l.ot ? 'OT ' + l.ot : ''].filter(Boolean).join(' · '); })()})</button>` : ''}
      <div class="calc" id="pCalc"></div>
      <button class="btn primary" id="pSave">${esc(p.name)} 실수령액 저장</button>
      <div class="small" style="margin-top:8px">직장마다 시급·가산율·PAYG·Super를 따로 설정할 수 있어요 (설정 → 직장).</div>
    </div>
    <div class="card">
      <div class="h2">직장별 <span class="label">이 달 받은 금액 · 다음 페이일</span></div>
        ${jobs.map(j => { const o = perJob.find(x => x.j.id === j.id), nx = payDate(j, 1);
          return `<div class="set-row"><span><b>${esc(j.name)}</b> <span class="small">${money(j.rate)}/h · ${j.freq ? FREQ_N[j.freq] : '페이일 미설정'}</span><br>
            <span class="small">${o ? `${o.n}회 · ${r2(o.hrs)}시간` : '이 달 기록 없음'}${nx ? ` · 다음 ${+nx.slice(5, 7)}/${+nx.slice(8)} (${WD[parseD(nx).getDay()]}) <b class="due">${dday(nx)}</b>` : ''}</span></span>
            <span class="num"><b>${money(o?.net || 0)}</b></span></div>`; }).join('')}
        <div style="height:14px"></div>
      <div class="h2">이 달 수입</div>${list.length ? list.map(t => itemHTML(t).replace('<b>', `<b>${+t.date.slice(8)}일 · `)).join('') : '<div class="empty">수입 기록이 없어요. + 버튼 → 수입으로 송금 등 추가</div>'}</div></div>`;
  const ids = { ord: '#pOrd', sat: '#pSat', sun: '#pSun', ot: '#pOt' };
  const upd = () => {
    if (payDraft.date !== $('#pDate').value) payDraft.dateTouched = true;
    payDraft.date = $('#pDate').value; Object.entries(ids).forEach(([k, s]) => payDraft[k] = $(s).value);
    const h = Object.fromEntries(Object.keys(ids).map(k => [k, parseFloat(payDraft[k]) || 0]));
    const c = payCalc({ ...p, ...h });
    $('#pCalc').innerHTML = `<span class="k">Gross</span><span class="v num">${money(c.gross)}</span>
      <span class="k">PAYG (${r2(p.payg * 100)}%)</span><span class="v num">−${money(c.tax)}</span>
      <span class="k">Super (${r2(p.super * 100)}%, 별도)</span><span class="v num">${money(c.sup)}</span>
      <span class="k tot">Net</span><span class="v tot num">${money(c.net)}</span>`;
    return { h, c };
  };
  view.querySelectorAll('input').forEach(i => i.oninput = upd); upd();
  view.querySelectorAll('[data-job]').forEach(b => b.onclick = () => { payDraft.jobId = b.dataset.job; renderIncome(); });
  $('#pLast') && ($('#pLast').onclick = () => { const l = lastSlip(p.id).pay; Object.assign(payDraft, { ord: l.ord || '', sat: l.sat || '', sun: l.sun || '', ot: l.ot || '' }); renderIncome(); });
  $('#addJobGo').onclick = () => { S.tab = 'settings'; S.focusJobs = true; render(); };
  $('#pSave').onclick = async () => {
    const { h, c } = upd(); const savedDate = payDraft.date;
    if (!c.gross) return toast('근무 시간을 입력하세요');
    const nid = uid();
    await store.saveTx({ id: nid, ts: Date.now(), date: payDraft.date, kind: 'income', cat: p.name, src: 'AU', amount: c.net, memo: '',
      pay: { ...h, jobId: p.id, job: p.name, rate: p.rate, satL: p.satL, sunL: p.sunL, otL: p.otL, payg: p.payg, super: p.super } });
    Object.assign(payDraft, { ord: '', sat: '', sun: '', ot: '', dateTouched: false });
    undoable(`${p.name} ${+payDraft.date.slice(5, 7)}/${+payDraft.date.slice(8)} 지급분 저장됨 ${money(c.net)}${ym(payDraft.date) !== S.month ? ` (${+payDraft.date.slice(5, 7)}월 수입으로 기록)` : ''}`, () => store.deleteTx(nid));
  };
  bindItems();
}

function renderSettings() {
  const s = S.settings, jobs = getJobs();
  const dowN = ['일', '월', '화', '수', '목', '금', '토'];
  view.innerHTML = `<div class="set-grid"><div class="set-col">
    <div class="card"><div class="h2">계정</div>
      <div class="set-row"><span>${store.mode === 'cloud' ? '구글 계정' : '저장 위치'}</span><span class="r">${esc(S.user?.email || S.user?.name || '')}</span></div>
      <div class="set-row"><span>모드</span><span class="r">${store.mode === 'cloud' ? '클라우드 동기화' : '로컬 (이 기기 브라우저에만)'}</span></div>
      ${store.mode === 'cloud' ? (store.encrypted ? `<div class="set-row"><span>암호화</span><span class="r">켜짐 (장부 비밀번호)</span></div>
        <p class="p">기록은 장부 비밀번호로 기기에서 암호화돼 저장돼요. 비밀번호를 잊으면 복구할 수 없으니 가끔 백업 파일을 저장해 두세요.</p>
        <div class="btns"><button class="outline" id="chPw">비밀번호 변경</button><button class="outline" id="lockDev">이 기기에서 잠그기</button></div>
        <button class="ghost btn" id="encOff" style="margin-top:4px">암호화 끄기</button>`
        : `<div class="set-row"><span>암호화</span><span class="r">꺼짐</span></div>
        <p class="p">지금은 기록이 암호화 없이 저장돼요. 다른 사람과 앱을 같이 쓰게 되면 암호화를 켜 두는 걸 추천해요 (관리자도 못 보게 됨).</p>
        <button class="outline btn" id="chPw">암호화 켜기 (장부 비밀번호 만들기)</button>`) + `
        <button class="outline btn" id="logout" style="margin-top:8px">로그아웃</button>` : '<p class="p">Firebase 설정값을 config.js에 넣으면 폰·PC 동기화 모드로 바뀌어요.</p>'}
    </div>
    <div class="card"><div class="h2">잔고 기준점</div>
      <p class="p">이 날짜의 시작 잔고를 기준으로 이후 모든 수입·지출을 더하고 빼서 잔고를 계산해요.</p>
      <div class="form-grid"><label>기준일<input type="date" id="sDate" value="${s.startDate}"></label>
      <label>시작 잔고 ($)<input inputmode="decimal" id="sBal" value="${s.startBalance}"></label></div>
    </div>
    <div class="card" id="jobsCard"><div class="h2">직장 <span class="label">주급 계산 기준</span></div>
      ${jobs.map((j, i) => `<div class="job-blk" data-jid="${esc(j.id)}">
        <div class="job-head"><input data-jf="name" value="${esc(j.name)}" aria-label="직장 이름">${jobs.length > 1 ? `<button class="ghost danger" style="margin:0" data-deljob="${esc(j.id)}">삭제</button>` : ''}</div>
        <div class="form-grid g3">
          <label>시급 ($)<input inputmode="decimal" data-jf="rate" value="${j.rate}"></label>
          <label>PAYG (%)<input inputmode="decimal" data-jf="payg" value="${r2(j.payg * 100)}"></label>
          <label>Super (%)<input inputmode="decimal" data-jf="super" value="${r2(j.super * 100)}"></label>
          <label>토요일 ×<input inputmode="decimal" data-jf="satL" value="${j.satL}"></label>
          <label>일요일 ×<input inputmode="decimal" data-jf="sunL" value="${j.sunL}"></label>
          <label>초과근무 ×<input inputmode="decimal" data-jf="otL" value="${j.otL}"></label>
          <label>페이 주기<select data-jf="freq"><option value="">미설정</option>${Object.entries(FREQ_N).map(([k, n]) => `<option value="${k}" ${j.freq === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          ${j.freq === 'monthly' ? `<label>페이일<select data-jf="payDom">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${(j.payDom || 1) === i + 1 ? 'selected' : ''}>${i + 1}일</option>`).join('')}</select></label>`
            : j.freq === 'weekly' ? `<label>페이 요일<select data-jf="payDow">${WD.map((d, i) => `<option value="${i}" ${(j.payDow ?? 4) === i ? 'selected' : ''}>${d}요일</option>`).join('')}</select></label>` : '<span></span>'}
          ${j.freq === 'fortnightly' ? `<label>최근 페이일<input type="date" data-jf="anchor" value="${j.anchor || ''}"></label>` : '<span></span>'}
        </div>${j.freq ? `<div class="small" style="margin-top:6px">${(() => { const n = payDate(j, 1); return n ? `다음 페이일 ${n} (${WD[parseD(n).getDay()]}) · ${dday(n)}` : '2주 주기는 최근 페이일을 하나 넣어 주세요'; })()}</div>` : ''}</div>`).join('')}
      <button class="outline btn" id="addJob" style="margin-top:12px">+ 직장 추가</button>
      <p class="p" style="margin-bottom:0">이미 저장된 주급은 저장 당시 시급으로 남아 있어요. 세금 면제 한도(tax-free threshold)는 보통 한 직장에서만 신청하니, 나머지 직장은 실제 페이슬립의 PAYG 비율에 맞춰 넣어 주세요.</p>
    </div>
    </div><div class="set-col"><div class="card"><div class="h2">반복 고정비 <span class="label">날짜가 되면 자동 등록</span></div>
      ${(s.recurring || []).map(r => `<div class="set-row"><span><b>${esc(r.cat)}</b> ${money(r.amount)}${r.memo ? ' · ' + esc(r.memo) : ''}<br><span class="small">${r.freq === 'weekly' ? `매주 ${dowN[r.dow]}요일` : `매월 ${r.dom}일`} · 다음 ${r.next}</span></span>
        <button class="ghost danger" style="margin:0" data-delrec="${r.id}">삭제</button></div>`).join('') || '<div class="empty" style="padding:8px">없음</div>'}
      <div class="form-grid" style="margin-top:10px">
        <label>항목<select id="rCat">${s.fixedCats.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label>금액 ($)<input inputmode="decimal" id="rAmt" placeholder="290"></label>
        <label>주기<select id="rFreq"><option value="weekly">매주</option><option value="monthly">매월</option></select></label>
        <label id="rWhenL">요일<select id="rWhen">${dowN.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d}요일</option>`).join('')}</select></label>
        <label style="grid-column:1/-1">메모 (선택)<input id="rMemo" placeholder="예: Electricity"></label>
      </div>
      <button class="outline btn" id="rAdd" style="margin-top:10px">반복 고정비 추가</button>
    </div>
    <div class="card"><div class="h2">카테고리</div>
      <label class="fld">변동비 (쉼표로 구분)<input id="cats" value="${esc(s.categories.join(', '))}"></label>
      <label class="fld" style="margin-top:10px">고정비 (쉼표로 구분)<input id="fcats" value="${esc(s.fixedCats.join(', '))}"></label>
      <p class="p" style="margin-bottom:0">이름을 바꿔도 이미 기록된 내역의 카테고리는 그대로예요. 설정은 입력하면 자동 저장돼요.</p>
    </div>

    <div class="card"><div class="h2">카테고리 월 예산 <span class="label">비워 두면 예산 없음</span></div>
      <div class="form-grid">${s.categories.map(c => `<label>${esc(c)} ($)<input inputmode="decimal" data-bud="${esc(c)}" value="${(s.budgets || {})[c] ?? ''}" placeholder="없음"></label>`).join('')}</div>
      <p class="p" style="margin-bottom:0">홈 화면에 사용량/예산 막대와 '오늘까지 적정 사용량' 표시가 나와요.</p>
    </div>
    <div class="card"><div class="h2">백업 · 복원</div>
      <p class="p">백업 파일(.json)을 저장해 두면 언제든 복원하거나 다른 기기·계정으로 옮길 수 있어요.</p>
      <div class="btns"><button class="outline" id="exp">백업 저장</button><button class="outline" id="csv">CSV 내보내기</button></div>
      <div class="btns" style="margin-top:8px"><button class="outline" id="imp">백업 불러오기</button></div>
      <input type="file" id="impFile" accept=".json,application/json" hidden>
      <button class="ghost danger btn" id="wipe" style="margin-top:12px">전체 데이터 삭제</button>
    </div>
    </div></div><p class="small" style="text-align:center;margin:12px 0">기록 ${S.tx.length}건</p>`;
  const v = id => $(id).value;
  $('#rFreq').onchange = () => {
    const w = v('#rFreq') === 'weekly';
    $('#rWhenL').innerHTML = w ? `요일<select id="rWhen">${dowN.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d}요일</option>`).join('')}</select>`
      : `날짜<select id="rWhen">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}일</option>`).join('')}</select>`;
  };
  $('#rAdd').onclick = async () => {
    const amt = evalAmt(v('#rAmt')); if (!amt) return toast('금액을 입력하세요');
    const freq = v('#rFreq'), when = +v('#rWhen'), t = parseD(todayStr());
    let next;
    if (freq === 'weekly') { const d = new Date(t); d.setDate(d.getDate() + ((when - d.getDay() + 7) % 7)); next = dstr(d); }
    else { const dim = daysInMonth(ym(todayStr())); let d = new Date(t.getFullYear(), t.getMonth(), Math.min(when, dim)); if (d < t) { d = new Date(t.getFullYear(), t.getMonth() + 1, 1); d.setDate(Math.min(when, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); } next = dstr(d); }
    const r = { id: uid(), cat: v('#rCat'), amount: amt, memo: v('#rMemo').trim(), freq, next, ...(freq === 'weekly' ? { dow: when } : { dom: when }) };
    await store.saveSettings({ ...S.settings, recurring: [...(S.settings.recurring || []), r] }); toast('추가됨 · 다음 등록일 ' + next);
  };
  view.querySelectorAll('[data-delrec]').forEach(b => b.onclick = async () => {
    if (!confirm('이 반복 고정비를 삭제할까요? (이미 등록된 내역은 남아요)')) return;
    await store.saveSettings({ ...S.settings, recurring: S.settings.recurring.filter(r => r.id !== b.dataset.delrec) });
  });
  const autoSave = async () => {
    const num = (id, d) => { const x = parseFloat(v(id)); return isNaN(x) ? d : x; };
    const split = x => x.split(',').map(z => z.trim()).filter(Boolean);
    const ns = { ...S.settings, startDate: v('#sDate') || s.startDate, startBalance: num('#sBal', 0),
      jobs: readJobs(),
      categories: split(v('#cats')), fixedCats: split(v('#fcats')) };
    if (!ns.categories.length || !ns.fixedCats.length) return toast('카테고리를 하나 이상 넣어 주세요');
    await store.saveSettings(ns); toast('설정 저장됨', 1200);
  };
  const readJobs = () => [...view.querySelectorAll('.job-blk')].map(b => {
    const old = jobs.find(j => j.id === b.dataset.jid) || JOB_DEFAULT;
    const f = k => { const x = parseFloat(b.querySelector(`[data-jf="${k}"]`).value); return isNaN(x) ? null : x; };
    return { ...old, id: b.dataset.jid, name: b.querySelector('[data-jf="name"]').value.trim() || old.name || '직장',
      rate: f('rate') ?? old.rate, payg: (f('payg') ?? old.payg * 100) / 100, super: (f('super') ?? old.super * 100) / 100,
      satL: f('satL') ?? old.satL, sunL: f('sunL') ?? old.sunL, otL: f('otL') ?? old.otL,
      freq: b.querySelector('[data-jf="freq"]').value || null,
      payDow: b.querySelector('[data-jf="payDow"]') ? +b.querySelector('[data-jf="payDow"]').value : (old.payDow ?? (b.querySelector('[data-jf="anchor"]')?.value ? parseD(b.querySelector('[data-jf="anchor"]').value).getDay() : 4)),
      payDom: b.querySelector('[data-jf="payDom"]') ? +b.querySelector('[data-jf="payDom"]').value : (old.payDom ?? 1),
      anchor: b.querySelector('[data-jf="anchor"]') ? (b.querySelector('[data-jf="anchor"]').value || null) : (old.anchor ?? null) };
  });
  ['#sDate', '#sBal', '#cats', '#fcats'].forEach(id => $(id).onchange = autoSave);
  view.querySelectorAll('[data-bud]').forEach(i => i.onchange = async () => {
    const budgets = {}; view.querySelectorAll('[data-bud]').forEach(x => { const n = evalAmt(x.value); if (n > 0) budgets[x.dataset.bud] = n; });
    await store.saveSettings({ ...S.settings, budgets }); toast('예산 저장됨', 1200);
  });
  view.querySelectorAll('[data-jf]').forEach(i => i.onchange = autoSave);
  $('#addJob').onclick = async () => {
    const id = 'j' + uid();
    await store.saveSettings({ ...S.settings, jobs: [...readJobs(), { id, name: `Job ${jobs.length + 1}`, ...JOB_DEFAULT }] });
    toast('직장 추가됨 · 이름과 시급을 바꿔 주세요');
    setTimeout(() => view.querySelector(`[data-jid="${id}"] [data-jf="name"]`)?.select(), 50);
  };
  view.querySelectorAll('[data-deljob]').forEach(b => b.onclick = async () => {
    if (!confirm('이 직장을 삭제할까요? (이미 저장된 주급 기록은 남아요)')) return;
    await store.saveSettings({ ...S.settings, jobs: readJobs().filter(j => j.id !== b.dataset.deljob) });
  });
  if (S.focusJobs) { S.focusJobs = false; $('#jobsCard').scrollIntoView({ block: 'start' }); }
  $('#logout') && ($('#logout').onclick = () => store.logout());
  $('#lockDev') && ($('#lockDev').onclick = async () => { if (confirm('이 기기에서 기억한 장부 비밀번호를 지우고 로그아웃할까요?\n다음에 열 때 비밀번호를 다시 입력해야 해요.')) await store.lockDevice(); });
  $('#encOff') && ($('#encOff').onclick = async () => {
    if (!confirm('암호화를 끌까요? 모든 기록을 암호화 없이 다시 저장해요.\nFirebase 관리자가 내용을 볼 수 있게 돼요.')) return;
    toast('다시 저장하는 중…', 20000);
    try { await store.changePassword(null, S.settings); toast('암호화를 껐어요'); render(); } catch (e) { toast('실패: ' + (e.code || e.message), 5000); }
  });
  $('#chPw') && ($('#chPw').onclick = async () => {
    if (!store.encrypted && !confirm('암호화를 켜면 장부 비밀번호가 필요하고, 잊으면 아무도 복구할 수 없어요. 계속할까요?')) return;
    const a = prompt('새 장부 비밀번호 (8자 이상)'); if (!a) return;
    if (a.length < 8) return toast('8자 이상으로 정해 주세요');
    if (prompt('새 비밀번호를 한 번 더 입력하세요') !== a) return toast('두 비밀번호가 달라요');
    toast('다시 암호화하는 중…', 20000);
    const was = store.encrypted;
    try { await store.changePassword(a, S.settings); toast(was ? '비밀번호를 바꿨어요. 다른 기기에서는 새 비밀번호로 다시 열어야 해요' : '암호화를 켰어요. 다른 기기에서는 비밀번호를 입력해야 해요', 4000); render(); }
    catch (e) { toast('변경 실패: ' + (e.code || e.message), 5000); }
  });
  $('#exp').onclick = () => download(`가계부_백업_${todayStr()}.json`, JSON.stringify({ version: 1, settings: s, transactions: S.tx }, null, 1), 'application/json');
  $('#csv').onclick = () => {
    const rows = [['date', 'kind', 'category', 'amount', 'source', 'memo'], ...[...S.tx].sort((a, b) => a.date.localeCompare(b.date)).map(t => [t.date, t.kind, t.cat, t.amount, t.src || '', t.memo || ''])];
    download(`가계부_${todayStr()}.csv`, '﻿' + rows.map(r => r.map(x => /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',')).join('\n'), 'text/csv');
  };
  $('#imp').onclick = () => $('#impFile').click();
  $('#impFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.transactions) || !d.settings) throw new Error('형식이 맞지 않아요');
      if (!confirm(`${d.transactions.length}건을 불러올까요?\n같은 기록은 덮어쓰고, 설정도 백업 파일 것으로 바뀌어요.`)) return;
      toast('불러오는 중…', 10000);
      await store.saveMany(d.transactions.map(t => ({ ...t, amount: +t.amount })));
      await store.saveSettings(normalizeSettings(d.settings));
      S.pendingRender = false; render();
      toast(`${d.transactions.length}건 불러옴`);
    } catch (err) { toast('불러오기 실패: ' + err.message, 4000); }
    e.target.value = '';
  };
  $('#wipe').onclick = async () => {
    if (prompt('모든 기록과 설정을 지웁니다. 계속하려면 "삭제"를 입력하세요') !== '삭제') return;
    await store.wipe(S.tx); toast('전체 삭제됨');
  };
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ───────────── add / edit sheet ───────────── */
function catsFor(kind) { return kind === 'income' ? ['AU', 'KR'] : kind === 'fixed' ? S.settings.fixedCats : S.settings.categories; }
function drawChips() {
  const list = catsFor(S.kind); if (!list.includes(S.cat)) S.cat = null;
  $('#catChips').innerHTML = list.map(c => `<button class="chip ${S.cat === c ? 'on' : ''}" data-c="${esc(c)}" style="${S.cat === c && S.kind !== 'income' ? `background:${colorOf(c)};color:#fff` : ''}">${esc(c)}</button>`).join('');
  $('#catChips').querySelectorAll('[data-c]').forEach(b => b.onclick = () => { S.cat = b.dataset.c; drawChips(); });
  document.querySelectorAll('#kindSeg button').forEach(b => b.classList.toggle('on', b.dataset.kind === S.kind));
}
function updSum() { const v = $('#amt').value, x = evalAmt(v); $('#amtSum').innerHTML = /[+-]/.test(v.replace(/^-/, '')) ? (x === null ? '계산할 수 없는 식' : `= ${money(x)}`) : '&nbsp;'; }
function openSheet(t) {
  S.editing = t || null;
  S.kind = t?.kind || 'expense';
  S.cat = t ? (t.kind === 'income' ? (t.src || 'AU') : t.cat) : null;
  $('#amt').value = t ? (t.expr || t.amount) : '';
  $('#date').value = t?.date || (S.month === ym(todayStr()) ? todayStr() : S.month + '-01');
  $('#memo').value = t?.memo || '';
  $('#delBtn').hidden = !t; $('#dupBtn').hidden = !t;
  $('#favBox').innerHTML = t ? '' : favHTML();
  $('#favBox').querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => { const d = $('#date').value; closeSheet(); await addFav(b, d); });
  $('#kindSeg').style.display = t?.pay ? 'none' : '';
  drawChips(); updSum();
  $('#favBox').hidden = S.kind !== 'expense';
  $('#sheet').hidden = false;
  if (!t) setTimeout(() => $('#amt').focus(), 60);
}
function closeSheet() { $('#sheet').hidden = true; S.editing = null; }
async function saveSheet() {
  const raw = $('#amt').value, amt = evalAmt(raw);
  if (amt === null || amt === 0) return toast('금액을 확인해 주세요');
  if (!S.cat) return toast('카테고리를 골라 주세요');
  const date = $('#date').value || todayStr(), memo = $('#memo').value.trim();
  const prev = S.editing ? structuredClone(S.editing) : null;
  const base = S.editing || { id: uid(), ts: Date.now() };
  const t = { ...base, date, kind: S.kind, amount: amt, memo };
  if (/[+]|.-/.test(raw.replace(/\s/g, ''))) t.expr = raw.replace(/\s/g, ''); else delete t.expr;
  if (S.kind === 'income') { t.src = S.cat; t.cat = t.pay ? t.cat : (S.cat === 'KR' ? 'KR 송금' : 'AU 수입'); }
  else { t.cat = S.cat; delete t.src; delete t.pay; }
  closeSheet();
  await store.saveTx(t);
  if (ym(date) !== S.month) { S.month = ym(date); render(); }
  undoable(`${prev ? '수정' : '저장'}됨 · ${t.cat} ${money(amt)}`, () => prev ? store.saveTx(prev) : store.deleteTx(t.id));
}

/* ───────────── boot ───────────── */
function bindChrome() {
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); });
  $('#prevM').onclick = () => { S.month = addMonths(S.month, -1); render(); };
  $('#nextM').onclick = () => { S.month = addMonths(S.month, 1); render(); };
  $('#fab').onclick = () => openSheet();
  $('#sideAdd').onclick = () => openSheet();
  $('#todayM').onclick = () => { S.month = ym(todayStr()); render(); };
  mq.addEventListener('change', render);
  view.addEventListener('focusout', () => setTimeout(() => {
    if (S.pendingRender && !view.contains(document.activeElement)) { S.pendingRender = false; render(); }
  }, 0));
  document.addEventListener('keydown', e => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || !$('#sheet').hidden;
    if (typing || e.ctrlKey || e.metaKey || e.altKey || !S.ready) return;
    if (e.key === 'n' || e.key === 'N' || e.key === 'ㅜ') { e.preventDefault(); openSheet(); }
    else if (e.key === 'ArrowLeft' && S.tab !== 'settings') { S.month = addMonths(S.month, -1); render(); }
    else if (e.key === 'ArrowRight' && S.tab !== 'settings') { S.month = addMonths(S.month, 1); render(); }
  });
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
  document.querySelectorAll('#kindSeg button').forEach(b => b.onclick = () => { S.kind = b.dataset.kind; S.cat = null; drawChips(); $('#favBox').hidden = S.kind !== 'expense' || !!S.editing; });
  $('#amt').oninput = updSum;
  $('#amt').onkeydown = e => { if (e.key === 'Enter') saveSheet(); };
  $('#saveBtn').onclick = saveSheet;
  $('#delBtn').onclick = async () => { if (!S.editing) return; const old = structuredClone(S.editing); closeSheet(); await store.deleteTx(old.id); undoable(`삭제됨 · ${old.cat} ${money(old.amount)}`, () => store.saveTx(old)); };
  $('#dupBtn').onclick = async () => {
    if (!S.editing) return; const t = { ...structuredClone(S.editing), id: uid(), ts: Date.now(), date: todayStr() }; delete t.auto;
    closeSheet(); await store.saveTx(t); if (S.month !== ym(t.date)) { S.month = ym(t.date); render(); }
    undoable(`오늘 날짜로 복제됨 · ${t.cat} ${money(t.amount)}`, () => store.deleteTx(t.id));
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  // swipe months on home/list
  let x0 = null; view.addEventListener('touchstart', e => x0 = e.touches[0].clientX, { passive: true });
  view.addEventListener('touchend', e => { if (x0 === null || S.tab === 'settings') return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 80) { S.month = addMonths(S.month, dx < 0 ? 1 : -1); render(); } }, { passive: true });
  window.addEventListener('online', () => store?.mode === 'cloud' && setSync('ok'));
  window.addEventListener('offline', () => store?.mode === 'cloud' && setSync('off'));
}

let recurringRan = false;
function onData(d) {
  S.settings = normalizeSettings(d.settings);
  S.tx = d.tx; S.user = d.user; S.ready = true;
  const due = (S.settings.recurring || []).some(r => r.next && r.next <= todayStr());
  if (due && !recurringRan) { recurringRan = true; runRecurring().finally(() => recurringRan = false); }
  if (d.fresh && !onData.welcomed) { onData.welcomed = true; S.tab = 'settings'; toast('처음이에요! 잔고 기준점과 카테고리를 먼저 정해 주세요', 4000); }
  if (!$('#sheet').hidden) return; // don't redraw under open sheet inputs
  const ae = document.activeElement;
  if (ae && view.contains(ae) && ae.tagName === 'INPUT' && ae.type !== 'file' && ae.value) { S.pendingRender = true; return; } // 입력 중이면 화면을 덮어쓰지 않음
  render();
}

/** 장부 비밀번호 화면. mode: 'create' | 'unlock' */
function askPassword(mode, err = '') {
  S.ready = false; render();
  return new Promise(resolve => {
    const create = mode === 'create';
    view.innerHTML = `<form class="login lock" id="lockForm" autocomplete="off">
      <h2>${create ? '장부 비밀번호 만들기' : '장부 잠금 해제'}</h2>
      <p>${create ? '기록은 이 비밀번호로 <b>기기에서 암호화된 뒤</b> 저장돼요.<br>앱 관리자를 포함해 누구도 내용을 볼 수 없어요.' : `${esc(S.user?.email || '')}<br>이 기기에서 처음 열거나 잠근 뒤라 비밀번호가 필요해요.`}</p>
      <input type="password" id="pw1" placeholder="장부 비밀번호 (8자 이상)" autocomplete="${create ? 'new-password' : 'current-password'}">
      ${create ? '<input type="password" id="pw2" placeholder="한 번 더 입력" autocomplete="new-password">' : ''}
      ${create ? '<label class="agree"><input type="checkbox" id="pwOk"><span>비밀번호를 잊으면 <b>아무도 복구할 수 없다</b>는 걸 이해했어요</span></label>' : ''}
      <div class="lock-err" id="pwErr">${esc(err)}</div>
      <button class="btn primary" type="submit" id="pwGo">${create ? '만들고 시작하기' : '열기'}</button>
      <div class="lock-links"><button type="button" class="link" id="pwOut">다른 계정으로 로그인</button>
      ${create ? '' : '<button type="button" class="link danger-link" id="pwReset">비밀번호를 잊었어요</button>'}</div>
      ${create ? `<div class="plain-box"><button type="button" class="outline btn" id="pwPlain">비밀번호 없이 시작 (암호화 안 함)</button>
        <p class="small">혼자 쓸 때 편해요. 대신 Firebase 프로젝트 관리자는 내용을 볼 수 있어요. 나중에 설정에서 언제든 암호화를 켤 수 있어요.</p></div>` : ''}
    </form>`;
    setTimeout(() => $('#pw1')?.focus(), 50);
    $('#lockForm').onsubmit = e => {
      e.preventDefault();
      const a = $('#pw1').value;
      if (create) {
        if (a.length < 8) return $('#pwErr').textContent = '8자 이상으로 정해 주세요';
        if (a !== $('#pw2').value) return $('#pwErr').textContent = '두 비밀번호가 달라요';
        if (!$('#pwOk').checked) return $('#pwErr').textContent = '안내를 확인하고 체크해 주세요';
      } else if (!a) return;
      $('#pwGo').disabled = true; $('#pwGo').textContent = '확인 중…';
      resolve(a);
    };
    $('#pwOut').onclick = () => resolve({ logout: true });
    $('#pwPlain') && ($('#pwPlain').onclick = () => resolve({ plain: true }));
    $('#pwReset') && ($('#pwReset').onclick = () => {
      if (prompt('암호화된 데이터는 비밀번호 없이 복구할 수 없어요.\n이 계정의 모든 기록을 지우고 새로 시작하려면 "초기화"를 입력하세요.\n(백업 파일이 있다면 새로 시작한 뒤 불러올 수 있어요)') === '초기화') resolve({ reset: true });
    });
  });
}

function showLogin() {
  S.ready = false; render();
  view.innerHTML = `<div class="login"><h2>내 가계부</h2><p>구글 계정으로 로그인하면<br>폰과 PC에서 같은 장부를 쓸 수 있어요.</p>
    <button class="btn primary" id="loginBtn">Google로 로그인</button>
    <p class="small" style="margin-top:16px">기록은 로그인한 본인만 볼 수 있어요.</p></div>`;
  $('#loginBtn').onclick = () => store.login();
}

async function boot() {
  bindChrome();
  view.innerHTML = '<div class="empty">불러오는 중…</div>';
  if (firebaseConfig) {
    store = new FireStore(firebaseConfig, { defaults: DEFAULT_SETTINGS, toast, setSync, askPassword });
    try {
      await store.start(onData, user => { if (!user) { recurringRan = false; showLogin(); } else view.innerHTML = '<div class="empty">장부 불러오는 중…</div>'; });
    } catch (e) { view.innerHTML = `<div class="empty">Firebase 연결 실패<br><span class="small">${esc(e.message)}</span></div>`; }
  } else {
    store = new LocalStore(); setSync('local'); await store.start(onData);
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
