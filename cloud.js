/* 클라우드 저장소 (Firebase) — 기기 암호화 + 월 단위 묶음
 *
 * Firestore 구조
 *   users/{uid}                 { meta: { v, salt, iter, check }, s: <암호화된 설정> }
 *   users/{uid}/months/{YYYY-MM} { t: { <기록id>: <암호화된 기록> } }
 *
 * - 모든 기록·설정은 브라우저에서 AES-GCM(256)으로 암호화한 뒤 올라감.
 *   키는 사용자의 '장부 비밀번호'에서 PBKDF2-SHA256(600,000회)로 만듦 → 관리자도 내용을 볼 수 없음.
 * - 기록 하나 = 월 문서 안의 필드 하나라서, 두 기기에서 동시에 다른 기록을 저장해도 서로 덮어쓰지 않음.
 * - 앱을 열 때 읽기 = (월 문서 수 + 1)건 정도.
 */

const te = new TextEncoder(), td = new TextDecoder();
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const ITER = 600000;

export async function deriveKey(pass, saltB64, iter = ITER) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** key가 없으면(암호화 끔) 'p:'+JSON 평문으로 저장 */
export async function seal(key, obj) {
  if (!key) return 'p:' + JSON.stringify(obj);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
export async function open(key, str) {
  if (str.startsWith('p:')) return JSON.parse(str.slice(2));
  const u = unb64(str);
  return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12))));
}
const CHECK = 'fin-ok';
/** 서버에 보이는 필드 이름도 기록 ID를 숨김: SHA-256(salt:id) 앞 22자 */
async function fieldKey(salt, id) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(salt + ':' + id)));
  return b64(h).slice(0, 22).replace(/\+/g, '-').replace(/\//g, '_');
}

/** 이 기기에 키 기억 (IndexedDB, 키는 내보내기 불가 형태로 저장) */
export const idbKeyStore = {
  _db() {
    return new Promise((res, rej) => { const r = indexedDB.open('fin-keys', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async _op(mode, fn) { const db = await this._db(); return new Promise((res, rej) => { const tx = db.transaction('k', mode); const q = fn(tx.objectStore('k')); tx.oncomplete = () => res(q?.result); tx.onerror = () => rej(tx.error); }); },
  get(uid) { return this._op('readonly', s => s.get(uid)).catch(() => null); },
  set(uid, key) { return this._op('readwrite', s => s.put(key, uid)).catch(() => null); },
  del(uid) { return this._op('readwrite', s => s.delete(uid)).catch(() => null); },
};

export async function loadFirebase(V = '10.12.2') {
  const base = `https://www.gstatic.com/firebasejs/${V}/`;
  const [App, A, F] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  return { App, A, F };
}

export class FireStore {
  /**
   * @param cfg firebaseConfig
   * @param hooks { defaults, toast, setSync, askPassword(mode:'create'|'unlock', errorMsg) => Promise<string|{reset:true}|{logout:true}>, onLocked() }
   * @param deps  { App, A, F, keyStore } — 테스트에서 가짜를 넣을 수 있게 분리
   */
  constructor(cfg, hooks, deps = {}) { this.cfg = cfg; this.h = hooks; this.deps = deps; this.mode = 'cloud'; this.encrypted = true; }

  async start(onData, onAuth) {
    const { App, A, F } = this.deps.F ? this.deps : await loadFirebase();
    this.A = A; this.F = F; this.keyStore = this.deps.keyStore || idbKeyStore;
    const app = App.initializeApp(this.cfg);
    this.auth = A.getAuth(app);
    try { this.db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
    catch { this.db = F.getFirestore(app); }
    try { await A.getRedirectResult?.(this.auth); } catch (e) { console.warn(e); }
    A.onAuthStateChanged(this.auth, async user => {
      this._stop();
      if (!user) { this.key = null; onAuth(null); return; }
      this.uid = user.uid; this.user = { name: user.displayName || user.email, email: user.email };
      onAuth(this.user);
      try {
        if (!(await this._unlock())) return;
        this._subscribe(onData);
      } catch (e) { console.error(e); this.h.toast('장부를 여는 중 오류: ' + (e.code || e.message), 5000); }
    });
  }
  _stop() { this.unsubs?.forEach(u => u()); this.unsubs = []; }
  _userRef() { return this.F.doc(this.db, 'users', this.uid); }
  _monthRef(ym) { return this.F.doc(this.db, 'users', this.uid, 'months', ym); }

  /** 장부 비밀번호로 키를 준비. 성공하면 true */
  async _unlock() {
    const snap = await this.F.getDoc(this._userRef());
    const meta = snap.exists() ? snap.data().meta : null;
    if (!meta) { // 새 사용자 → 비밀번호 만들기 (또는 암호화 없이)
      const pass = await this.h.askPassword('create');
      if (pass?.logout) { await this.logout(); return false; }
      if (pass?.plain) {
        const m = { v: 1, plain: true, salt: 'plain-' + b64(crypto.getRandomValues(new Uint8Array(6))) };
        await this.F.setDoc(this._userRef(), { meta: m, s: await seal(null, this.h.defaults) });
        this.key = null; this.meta = m; this.encrypted = false; this.justCreated = true; return true;
      }
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const key = await deriveKey(pass, salt);
      const m = { v: 1, salt, iter: ITER, check: await seal(key, CHECK) };
      await this.F.setDoc(this._userRef(), { meta: m, s: await seal(key, this.h.defaults) });
      this.key = key; this.meta = m; this.encrypted = true; this.justCreated = true; await this.keyStore.set(this.uid, key);
      return true;
    }
    this.meta = meta;
    if (meta.plain) { this.key = null; this.encrypted = false; return true; }
    this.encrypted = true;
    const saved = await this.keyStore.get(this.uid);
    if (saved && await this._verify(saved, meta)) { this.key = saved; return true; }
    let err = '';
    for (;;) {
      const pass = await this.h.askPassword('unlock', err);
      if (pass?.logout) { await this.logout(); return false; }
      if (pass?.reset) { await this.resetAll(); return this._unlock(); }
      const key = await deriveKey(pass, meta.salt, meta.iter);
      if (await this._verify(key, meta)) { this.key = key; await this.keyStore.set(this.uid, key); return true; }
      err = '비밀번호가 맞지 않아요';
    }
  }
  async _verify(key, meta) { try { return (await open(key, meta.check)) === CHECK; } catch { return false; } }

  _subscribe(onData) {
    const F = this.F, cache = new Map(); // 암호문 → 복호화된 기록 (같은 암호문은 다시 풀지 않음)
    let settings, months = null, settingsSeen = false, seq = 0;
    this.idMonth = new Map();
    const emit = () => {
      if (!settingsSeen || !months) return;
      const tx = []; this.idMonth.clear();
      for (const [ym, m] of Object.entries(months)) for (const t of Object.values(m)) { tx.push(t); this.idMonth.set(t.id, ym); }
      this.tx = tx;
      onData({ settings: settings || structuredClone(this.h.defaults), tx, user: this.user, fresh: !settings || this.justCreated });
      this.justCreated = false;
    };
    this.unsubs.push(F.onSnapshot(this._userRef(), async snap => {
      const d = snap.exists() ? snap.data() : {};
      if (d.meta && d.meta.salt !== this.meta.salt) { // 다른 기기에서 비밀번호를 바꿈 → 다시 잠금 해제
        this._stop(); await this.keyStore.del(this.uid);
        if (!d.meta.plain) this.h.toast('장부 비밀번호가 바뀌어 다시 입력해야 해요', 4000);
        if (await this._unlock()) this._subscribe(onData); return;
      }
      try { settings = d.s ? await open(this.key, d.s) : null; } catch { settings = null; }
      settingsSeen = true; emit();
    }, err => this.h.toast('불러오기 오류: ' + err.code, 5000)));
    this.unsubs.push(F.onSnapshot(F.collection(this._userRef(), 'months'), { includeMetadataChanges: true }, async snap => {
      const my = ++seq, next = {}; let bad = 0;
      for (const doc of snap.docs) {
        const t = doc.data().t || {}, m = {};
        for (const sealed of Object.values(t)) {
          let v = cache.get(sealed);
          if (!v) { try { v = await open(this.key, sealed); cache.set(sealed, v); } catch { bad++; continue; } }
          m[v.id] = v;
        }
        next[doc.id] = m;
      }
      if (my !== seq) return; // 더 최신 스냅샷이 처리 중
      if (bad) this.h.toast(`풀 수 없는 기록 ${bad}건을 건너뛰었어요`, 4000);
      months = next; emit();
      this.h.setSync(snap.metadata.hasPendingWrites || snap.metadata.fromCache ? (navigator.onLine ? 'pending' : 'off') : 'ok');
    }, err => this.h.toast('불러오기 오류: ' + err.code, 5000)));
  }

  async login() {
    const p = new this.A.GoogleAuthProvider();
    try { await this.A.signInWithPopup(this.auth, p); }
    catch (e) {
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) await this.A.signInWithRedirect(this.auth, p);
      else if (e.code !== 'auth/popup-closed-by-user') this.h.toast('로그인 실패: ' + e.code, 5000);
    }
  }
  async logout() { this._stop(); this.key = null; await this.A.signOut(this.auth); }
  /** 이 기기에서 기억한 키를 지우고 로그아웃 */
  async lockDevice() { await this.keyStore.del(this.uid); await this.logout(); }

  async _fk(id, salt = this.meta.salt) { const k = salt + id; this._fkc ||= new Map(); if (!this._fkc.has(k)) this._fkc.set(k, await fieldKey(salt, id)); return this._fkc.get(k); }
  async _write(ops) { // ops: [['set', ref, data, opts?] | ['delField', ref, id] | ['delete', ref]]
    for (let i = 0; i < ops.length; i += 400) {
      const b = this.F.writeBatch(this.db);
      for (const [op, ref, a, o] of ops.slice(i, i + 400)) {
        if (op === 'set') o ? b.set(ref, a, o) : b.set(ref, a);
        else if (op === 'delField') b.update(ref, new this.F.FieldPath('t', a), this.F.deleteField());
        else b.delete(ref);
      }
      await b.commit();
    }
  }
  async saveTx(t) { return this.saveMany([t]); }
  async saveMany(list) {
    const byMonth = {}, ops = [];
    for (const t of list) {
      const ym = t.date.slice(0, 7);
      const fk = await this._fk(t.id);
      (byMonth[ym] ||= {})[fk] = await seal(this.key, t);
      const old = this.idMonth?.get(t.id);
      if (old && old !== ym) ops.push(['delField', this._monthRef(old), fk]); // 날짜를 다른 달로 옮긴 경우
    }
    for (const [ym, t] of Object.entries(byMonth)) ops.unshift(['set', this._monthRef(ym), { t }, { merge: true }]);
    await this._write(ops);
  }
  async deleteTx(id) { const ym = this.idMonth?.get(id); if (ym) await this._write([['delField', this._monthRef(ym), await this._fk(id)]]); }
  async saveSettings(s) { await this.F.setDoc(this._userRef(), { s: await seal(this.key, s) }, { merge: true }); }
  async wipe() {
    const snap = await this.F.getDocs(this.F.collection(this._userRef(), 'months'));
    await this._write(snap.docs.map(d => ['delete', d.ref]));
    await this.saveSettings(structuredClone(this.h.defaults));
  }
  /** 비밀번호를 잊었을 때: 모든 데이터를 지우고 처음부터 */
  async resetAll() {
    const snap = await this.F.getDocs(this.F.collection(this._userRef(), 'months'));
    await this._write([...snap.docs.map(d => ['delete', d.ref]), ['delete', this._userRef()]]);
    await this.keyStore.del(this.uid); this.key = null; this.meta = null;
  }
  /** 장부 비밀번호 설정/변경(암호화 켜기 포함): 새 키로 전부 다시 저장. newPass가 null이면 암호화 끄기 */
  async changePassword(newPass, currentSettings) {
    const salt = (newPass ? '' : 'plain-') + b64(crypto.getRandomValues(new Uint8Array(newPass ? 16 : 6)));
    const key = newPass ? await deriveKey(newPass, salt) : null;
    const meta = newPass ? { v: 1, salt, iter: ITER, check: await seal(key, CHECK) } : { v: 1, plain: true, salt };
    const byMonth = {};
    for (const t of this.tx || []) (byMonth[t.date.slice(0, 7)] ||= {})[await this._fk(t.id, salt)] = await seal(key, t);
    const ops = Object.entries(byMonth).map(([ym, t]) => ['set', this._monthRef(ym), { t }]);
    ops.push(['set', this._userRef(), { meta, s: await seal(key, currentSettings) }]);
    this.meta = meta; this.key = key; this.encrypted = !!newPass; // 내 스냅샷이 '비밀번호 바뀜'으로 오인하지 않게 먼저 교체
    await this._write(ops);
    if (key) await this.keyStore.set(this.uid, key); else await this.keyStore.del(this.uid);
  }
}
