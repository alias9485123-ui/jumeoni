(() => {
  "use strict";
  // 주머니 — RP 방마다 지갑 · 상점/배달 · 가방 · 퀘스트를 따로 두는 단말기 창.
  // 서버 호출은 사용자가 무언가를 눌렀을 때, 창을 열 때(지금 방 1번), 설정 탭을 처음 열 때(AI 연결 목록 1번),
  // 배달·사용 안내가 남아 있는 방의 답장이 끝났을 때, 진행 중인 임무가 있는 방의 답장이 끝났을 때(최근 메시지 2개 1번,
  // 완료 표시가 있으면 그 줄을 지우는 PATCH 1번)만 한다.
  // 비밀 탭: 탭을 열었을 때만 페르소나 목록(이 창이 떠 있는 동안 1번, 기억), 고른 페르소나의 로어북 · 항목(창을 열 때마다 1번)과
  // 지침 맞추기(필요할 때만 PATCH/POST)를 하고, 그 밖에는 누를 때만 부른다.
  // 재고: 사서 품목 재고가 0이 되면 그 자리에 들일 새 물건을 AI에게 한 번(generate/raw 1번 + 저장) 묻는다. 여러 개면 차례로 하나씩.
  // 돈 흐름: 자동 반영이 켜진 방은 답장이 끝났을 때 위와 같은 GET 1번으로 [송금/입금/출금: …] 표시를 함께 살피고, 표시는 같은 PATCH 1번으로 함께 지운다.
  // 월급 추측하기: 누를 때만 AI 1번(로어북 없이 카드 · 페르소나 · 지금 틀 요약).
  // 답장 맞추기(1.3.1): 엔진의 답장 끝 신호가 오지 않을 때를 대비해, 할 일이 남은 지금 방만
  // 창을 열 때 · 채팅 입력칸에 처음 입력할 때(4초에 1번까지) · 탭으로 돌아올 때 최근 메시지 4개를 GET 1번 읽고
  // 아직 처리하지 않은 답장(메시지 id#스와이프)만 한 번씩 처리한다. 새로 찾은 게 있을 때만 PATCH/저장.
  // 메시지 탭(1.4.0): 콘보 방 메신저. 탭을 열 때 콘보 목록 GET 1번 + 고른 콘보 최근 메시지 GET 1번(+ 안 읽음이 있으면 DELETE 1번),
  // 보낼 때 POST /api/generate 1번(스트림). 새 메시지는 엔진 알림 말풍선이 생기거나 바뀔 때만 10초에 1번까지 목록 GET 1번.
  // 주기 호출 · 자동 새로고침 없음.
  // 1.5.0: 겉모습만 바뀜(먹색 · 흑백 두 가지 화면 색, 작은 움직임). 움직임은 화면에서만 돌고 서버 호출은 늘지 않는다.
  // 1.7.0 콘보 → RP 다리: 엔진의 연결된 채팅은 한 방향이라(RP는 콘보를 읽지 않음) 콘보에서 주고받은 최근 문자를 숨김 메시지에 넣는다.
  //  메시지 탭에서 보낸 · 받은 문자는 바로 넣고(호출 없음), 지금 RP 방의 콘보가 답장을 끝냈을 때 · 창을 열 때 · 탭으로 돌아올 때 ·
  //  채팅 입력칸에 새 메시지를 쓰기 시작할 때만 콘보 최근 메시지 8개를 GET 1번(4초에 1번까지). 바뀐 게 있을 때만 숨김 메시지 · 저장.
  const VERSION = "1.7.4";
  const DATA_KEY = "jumeoniV1";
  const POS_KEY = "marinara.jumeoni.fab.v1";
  const PENDING_KEY = "marinara.jumeoni.pending.v1";
  const ALERT_KEY = "marinara.jumeoni.questAlert.v1";
  const AI_KEY = "marinara.jumeoni.ai.v1";
  const TONE_KEY = "marinara.jumeoni.tone.v1"; // 화면 색: "ink"(먹색, 기본) · "paper"(흑백). 모든 방에 똑같이.
  const ACTIVE_KEY = "marinara-active-chat-id";
  // 엔진 shared/constants/providers.ts 의 NON_CHAT_PROVIDERS 와 같은 목록. 글을 쓰지 못하는 연결은 고르지 못하게 뺀다.
  const NON_CHAT_PROVIDERS = ["image_generation", "video_generation", "audio_generation", "audio", "decision"];
  const AI_DEFAULT_LABEL = "방에 연결된 모델";
  const ROOT_ID = "jmn-root-v1";
  const CSRF_HEADER = "x-marinara-csrf";
  const CTX_HEAD = "[주머니] 이야기 참고용 현재 상태예요. 자연스럽게만 반영하세요.";
  const QUEST_MARK_LINE = "이야기 속에서 위 임무가 실제로 끝났을 때만, 답장 맨 끝에 [임무 완료: 임무 제목]을 한 줄로 덧붙이세요.";
  const SALARY_TOKENS = 800;
  const MONEY_ABSURD = 1000000; // 이 값보다 크고 가장 큰 잔고의 100배보다 크면 잘못 쓴 금액으로 보고 건너뛴다.
  const SAVE_MS = 800;
  const API_TIMEOUT_MS = 20000;
  const MODEL_TIMEOUT_MS = 120000;
  const SETUP_TOKEN_CAP = 6000;
  const QUEST_LORE_CAP = 1500;
  const CAP = { ledger: 100, bag: 200, quests: 60, done: 30, deliveries: 10, shops: 8, items: 20, wallets: 9, books: 12, soldOut: 20, replies: 30 };
  const RECON_GAP_MS = 4000; // 입력칸 · 탭 돌아오기 · 창 열기로 답장을 맞추는 최소 간격
  const RECON_LIMIT = 4; // 답장 맞추기에서 읽는 최근 메시지 수
  const BRIDGE_KEY = "marinara.jumeoni.bridge.v1"; // 콘보 다리를 쓰는 RP 방 id(이 기기). 새로고침 뒤 창을 열지 않아도 다리가 돌게.
  const BRIDGE_LIMIT = 8; // 콘보 다리에서 읽는 최근 메시지 수
  const FEED_MAX = 6; // 숨김 메시지에 넣는 콘보 문자 줄 수
  const FEED_TEXT = 140; // 한 줄 글자 수
  const FEED_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3일보다 오래된 줄은 넣지 않는다
  const FEED_TOKENS = 180; // 콘보 문자 묶음 예상 토큰 상한
  const FEED_HEAD = "[메신저(콘보)로 나눈 최근 문자 — 이야기 밖에서 주고받은 문자예요. 장면과 자연스럽게 이어지면 반영하세요]";
  const COMPOSER_TRIES = 3; // 보낸 뒤 입력칸에서 빈손으로 확인할 최대 횟수(답장이 아직 안 왔을 때)
  const STOCK_MAX = 999;
  const STOCK_DEFAULT = 5; // 세계관 읽기에서 AI가 재고를 빠뜨렸을 때(상점 · 배달 모두, 배달은 하루 만들 수 있는 양)
  const RESTOCK_TOKENS = 600;
  const FAB = 36, EDGE = 8;
  const TABS = [["wallet", "지갑"], ["shop", "상점"], ["bag", "가방"], ["quest", "퀘스트"], ["secret", "비밀"], ["msg", "메시지"], ["set", "설정"]];

  // ── 호스트 · 정리 ──
  const hostApi = (typeof marinara !== "undefined" && marinara && typeof marinara === "object") ? marinara : {};
  const cleanupFns = [];
  function onCleanup(fn) { if (typeof fn === "function") cleanupFns.push(fn); }
  function listen(target, type, handler, options) {
    if (!target || typeof handler !== "function") return () => {};
    target.addEventListener(type, handler, options);
    const off = () => target.removeEventListener(type, handler, options);
    onCleanup(off);
    return off;
  }
  const timers = {
    set: (fn, ms) => (typeof hostApi.setTimeout === "function" ? hostApi.setTimeout(fn, ms) : window.setTimeout(fn, ms)),
    clear: (id) => (typeof hostApi.clearTimeout === "function" ? hostApi.clearTimeout(id) : window.clearTimeout(id)),
  };
  const log = {
    warn: (...a) => { try { (hostApi.log?.warn || console.warn)(...a); } catch {} },
  };
  function hostFetch(input, init) { return typeof hostApi.fetch === "function" ? hostApi.fetch(input, init) : fetch(input, init); }
  function est(s) {
    const t = String(s || "");
    if (!t) return 0;
    try {
      if (typeof hostApi.estimateTextTokens === "function") { const n = Number(hostApi.estimateTextTokens(t)); if (Number.isFinite(n) && n >= 0) return Math.ceil(n); }
    } catch {}
    return Math.ceil(t.length / 1.5);
  }
  /** 예상 토큰이 max를 넘지 않게 뒤를 자른다. */
  function truncTokens(s, max) {
    const t = String(s || "");
    if (max <= 0) return "";
    if (est(t) <= max) return t;
    let lo = 0, hi = t.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (est(t.slice(0, mid)) <= max - 1) lo = mid; else hi = mid - 1; }
    return lo > 0 ? `${t.slice(0, lo)}…` : "";
  }

  // ── 작은 도구 ──
  const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function parseRecord(v) {
    if (isRecord(v)) return v;
    if (typeof v === "string" && v.trim().startsWith("{")) { try { const p = JSON.parse(v); return isRecord(p) ? p : {}; } catch { return {}; } }
    return {};
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v, max = 500) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
  const text = (v, max = 2000) => String(v == null ? "" : v).trim().slice(0, max);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pad = (n) => String(n).padStart(2, "0");
  function fmtTime(ts) { const d = new Date(ts); return Number.isNaN(d.getTime()) ? "" : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  /** 0 이상의 정수. 못 읽으면 0. */
  function num(v) {
    const n = typeof v === "number" ? v : Number(String(v == null ? "" : v).replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? Math.min(Math.max(0, Math.round(n)), 1e15) : 0;
  }
  function signedNum(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(-1e15, Math.round(n)), 1e15) : 0; }
  const fmt = (n) => { try { return Number(n || 0).toLocaleString("ko-KR"); } catch { return String(n || 0); } };
  const signed = (n) => `${n > 0 ? "+" : ""}${fmt(n)}`;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** DOM 만들기. 글자는 항상 textContent로만 넣는다. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = String(v);
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const addCls = (el, c) => { if (el && c) el.className = `${el.className || ""} ${c}`.trim(); return el; };

  // ── 작은 움직임 (1.5.0) ──
  // 화면에서만 돈다(네트워크 없음). 동작 줄이기 설정이면 CSS가 모든 움직임을 끄고, JS 숫자 굴리기도 하지 않는다.
  // 다시 그려도 움직임이 처음부터 되풀이되지 않도록, 시작 시각을 기억해 두고 animation-delay를 음수로 준다.
  function calm() {
    try { return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
  }
  const fxTimers = new Set();
  /** 움직임용 한 번짜리 타이머. 정리할 때 모두 지운다. */
  function later(fn, ms) {
    const id = timers.set(() => { fxTimers.delete(id); fn(); }, ms);
    fxTimers.add(id);
    return id;
  }
  function unlater(id) { if (id == null) return; timers.clear(id); fxTimers.delete(id); }
  onCleanup(() => { for (const id of fxTimers) timers.clear(id); fxTimers.clear(); });
  /** 이미 t0에 시작한 움직임을 이어서 보여 주기. */
  function lag(el, t0) { if (el && el.style) el.style.animationDelay = `-${Math.max(0, Date.now() - t0)}ms`; return el; }
  const fxAt = new Map(); // 움직임 이름 → 시작 시각
  function fxMark(k) {
    const now = Date.now();
    fxAt.set(k, now);
    if (fxAt.size > 400) for (const [x, t] of fxAt) if (now - t > 10000) fxAt.delete(x);
  }
  /** 시작한 지 ms가 안 됐으면 cls를 붙이고 이어서 보여 준다. */
  function fxCls(el, k, cls, ms) {
    const t = fxAt.get(k);
    if (t != null && Date.now() - t < ms) { addCls(el, cls); lag(el, t); }
    return el;
  }
  // 새로 그린 화면이 문서에 들어간 뒤에 할 일(트랜지션 시작점 → 끝점).
  let paintQ = [];
  function afterPaint(fn) { paintQ.push(fn); }
  function runPaint() { const q = paintQ; paintQ = []; for (const fn of q) { try { fn(); } catch {} } }
  /** 스타일 하나를 from에서 to로 트랜지션. 처음 보거나 같으면 바로 to. */
  function slideFrom(el, prop, from, to) {
    if (!el || !el.style) return el;
    if (from == null || from === to || calm()) { el.style[prop] = to; return el; }
    el.style[prop] = from;
    afterPaint(() => { void el.offsetWidth; el.style[prop] = to; });
    return el;
  }
  // 목록에 방금 생긴 줄 찾기. 그 목록을 처음 그릴 때는 아무것도 새것으로 보지 않는다.
  const seenRows = new Map();
  function freshRows(key, ids) {
    const prev = seenRows.get(key);
    if (seenRows.size > 300) seenRows.clear();
    seenRows.set(key, new Set(ids));
    if (prev) for (const id of ids) if (!prev.has(id)) fxMark(`row:${key}:${id}`);
  }
  const rowIn = (el, key, id) => fxCls(el, `row:${key}:${id}`, "jmn-rowin", 450);

  // ── 네트워크 (같은 출처 /api) ──
  async function api(path, { method = "GET", body, timeoutMs = API_TIMEOUT_MS } = {}) {
    const init = { method, headers: {}, credentials: "same-origin", cache: "no-store" };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
    if (method !== "GET") init.headers[CSRF_HEADER] = "1";
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (controller) init.signal = controller.signal;
    const t = controller ? timers.set(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await hostFetch(`/api/${path}`, init);
      const raw = await res.text();
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
      if (!res.ok) {
        const err = new Error((isRecord(data) && (data.error || data.message)) || `요청 실패 (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e?.name === "AbortError") throw new Error(`${Math.round(timeoutMs / 1000)}초 안에 응답이 없어요.`);
      throw e;
    } finally { if (t != null) timers.clear(t); }
  }
  const enc = encodeURIComponent;

  // ── 방 데이터 ──
  function freshData(chatId) {
    return {
      v: 1, ownerChatId: chatId, pack: { currency: "골드", statName: "", shops: [] },
      wallets: [{ id: uid(), who: "pc", name: "나", balance: 0 }], stat: 0, ledger: [], bag: [], quests: [], deliveries: [],
      send: true, autoMoney: true, processedReplies: [], prBase: false, usedNote: "", contextMessageId: "", contextText: "",
      convoBridge: true, convoFeed: [], ledgerShare: 5,
    };
  }
  /** 콘보 문자 한 줄 { id, who, name, text, ts }. 못 쓰는 줄은 null. */
  function normFeed(x) {
    if (!isRecord(x)) return null;
    const raw = collapse(x.text);
    const t = raw.length > FEED_TEXT ? `${raw.slice(0, FEED_TEXT - 1)}…` : raw;
    const out = { id: str(x.id, 256), who: x.who === "user" ? "user" : "char", name: str(x.name, 40), text: t, ts: Number(x.ts) || 0 };
    return out.id && out.text && out.ts > 0 ? out : null;
  }
  /** 월급 { amount, when, from }. 셋 다 비면 null. 금액이 0이면 숨김 전달에 넣지 않는다. */
  function normSalary(s) {
    if (!isRecord(s)) return null;
    const out = { amount: num(s.amount), when: str(s.when, 40), from: str(s.from, 60) };
    return out.amount > 0 || out.when || out.from ? out : null;
  }
  function normWallet(w) {
    const out = { id: str(w?.id, 40) || uid(), who: w?.who === "pc" ? "pc" : "npc", characterId: str(w?.characterId, 256), name: str(w?.name, 40), balance: num(w?.balance) };
    const salary = normSalary(w?.salary);
    if (salary) out.salary = salary;
    return out;
  }
  function normLedger(e) {
    const out = { id: str(e?.id, 40) || uid(), ts: Number(e?.ts) || 0, title: str(e?.title, 100), sub: str(e?.sub, 100), amount: signedNum(e?.amount), walletId: str(e?.walletId, 40), k: str(e?.k, 10) };
    // 자동 반영 내역: 어느 답장(메시지 id · 스와이프)에서 왔는지, 송금이면 두 통장 줄을 묶는 g.
    if (isRecord(e?.src)) out.src = { messageId: str(e.src.messageId, 256), swipe: Math.max(0, Math.round(Number(e.src.swipe) || 0)) };
    const g = str(e?.g, 40);
    if (g) out.g = g;
    const rp = str(e?.rp, 40);
    if (rp) out.rp = rp;
    return out;
  }
  /** 재고: 0~999 정수, null = 무제한. 비었거나 못 읽으면 def. */
  function parseStock(v, def) {
    if (v == null || (typeof v === "string" && !v.trim())) return def;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? Math.min(Math.max(0, Math.round(n)), STOCK_MAX) : def;
  }
  /** 품목 하나. defStock이 있으면 AI가 만든 값이라 빠진 재고는 defStock, 0은 1로 올린다. 없으면(저장된 값) 빠진 재고는 무제한. */
  function normItem(i, defStock = null) {
    let stock = parseStock(i?.stock, defStock);
    if (defStock != null && stock === 0) stock = 1;
    const it = { id: str(i?.id, 40) || uid(), name: str(i?.name, 60), price: num(i?.price), stock };
    const note = str(i?.note, 80);
    if (note) it.note = note;
    // 다 팔린 품목: 새 물건을 들이는 중이거나 들이지 못한 상태.
    if (stock === 0) { it.pending = true; it.soldOutAt = Number(i?.soldOutAt) || 0; }
    return it;
  }
  function normShop(s, defStock = null) {
    return {
      id: str(s?.id, 40) || uid(), name: str(s?.name, 60), kind: /deliver|배달/i.test(String(s?.kind || "")) ? "delivery" : "shop", desc: str(s?.desc, 120),
      items: arr(s?.items).map((i) => normItem(i, defStock)).filter((i) => i.name).slice(0, CAP.items),
      soldOutHistory: arr(s?.soldOutHistory).map((x) => str(x, 60)).filter(Boolean).slice(-CAP.soldOut),
    };
  }
  /** 재고를 바꾼 뒤 품절 표시 맞추기. */
  function setStock(it, stock) {
    it.stock = stock;
    if (stock === 0) { it.pending = true; if (!it.soldOutAt) it.soldOutAt = Date.now(); }
    else { delete it.pending; delete it.soldOutAt; }
  }
  /** 받침에 맞는 조사(이/가 등). 한글이 아니면 "이(가)". */
  function josa(word, withB, without) {
    const c = String(word || "").trim().slice(-1).charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? withB : without;
    return `${withB}(${without})`;
  }
  function normQuest(q, status) {
    const st = status || (q?.status === "active" || q?.status === "done" ? q.status : "offered");
    return {
      id: str(q?.id, 40) || uid(), title: str(q?.title, 100), giver: str(q?.giver, 60), rewardMoney: num(q?.rewardMoney), rewardStat: num(q?.rewardStat), desc: str(q?.desc, 240), status: st,
      // 답장 끝의 [임무 완료: …] 표시로 "끝난 것 같다"고 본 메시지 id. 진행 중인 임무만 가진다.
      doneSuggested: st === "active" ? str(q?.doneSuggested, 256) : "",
      // 이미 제안한 메시지(id#스와이프). 같은 답장으로 다시 제안하지 않는다.
      suggestSeen: str(q?.suggestSeen, 300),
    };
  }
  /** 저장된 값을 안전한 모양으로. 월드 팩이 없으면 null(= 아직 만들지 않은 방). */
  function normalize(raw, chatId) {
    const r = parseRecord(raw);
    if (!isRecord(r.pack)) return null;
    const d = freshData(chatId);
    d.ownerChatId = str(r.ownerChatId, 256) || chatId;
    d.pack.currency = str(r.pack.currency, 20) || "골드";
    d.pack.statName = str(r.pack.statName, 30);
    d.pack.shops = arr(r.pack.shops).map((s) => normShop(s)).filter((s) => s.name).slice(0, CAP.shops);
    const wallets = arr(r.wallets).map(normWallet).filter((w) => w.name);
    const pc = wallets.find((w) => w.who === "pc") || d.wallets[0];
    delete pc.characterId;
    d.wallets = [pc, ...wallets.filter((w) => w.who === "npc").slice(0, CAP.wallets - 1)];
    d.stat = num(r.stat);
    d.rpTime = str(r.rpTime, 40);
    d.ledger = arr(r.ledger).map(normLedger).filter((e) => e.title).slice(0, CAP.ledger);
    d.bag = arr(r.bag).map((b) => ({ id: str(b?.id, 40) || uid(), name: str(b?.name, 60), qty: num(b?.qty) })).filter((b) => b.name && b.qty > 0).slice(0, CAP.bag);
    d.quests = arr(r.quests).map((q) => normQuest(q)).filter((q) => q.title).slice(0, CAP.quests);
    d.deliveries = arr(r.deliveries).map((x) => ({ id: str(x?.id, 40) || uid(), itemName: str(x?.itemName, 60), shopName: str(x?.shopName, 60), qty: Math.max(1, num(x?.qty)), stage: Number(x?.stage) === 2 ? 2 : 1 }))
      .filter((x) => x.itemName).slice(0, CAP.deliveries);
    d.send = r.send !== false;
    d.autoMoney = r.autoMoney !== false;
    // 처리한 답장(메시지 id#스와이프). 1.3.0의 moneySeen · 임무별 suggestSeen도 여기로 옮긴다.
    const seenRaw = [...arr(r.processedReplies), ...arr(r.moneySeen), ...arr(r.quests).map((q) => q?.suggestSeen)]
      .map((x) => str(x, 300)).filter((k) => /#\d+$/.test(k));
    d.processedReplies = seenRaw.filter((k, i) => seenRaw.lastIndexOf(k) === i).slice(-CAP.replies);
    // 1.3.0 데이터: 숨김 메시지가 최근 메시지 안에 없으면, 처음 한 번은 가장 새 답장을 이미 처리한 것으로 본다(배달 두 번 넘김 방지).
    d.prBase = !Array.isArray(r.processedReplies) || r.prBase === true;
    d.usedNote = str(r.usedNote, 120);
    d.contextMessageId = str(r.contextMessageId, 256);
    d.contextText = text(r.contextText, 4000);
    // 1.7.0: 콘보 다리(없던 데이터는 켜짐 · 빈 목록).
    d.convoBridge = r.convoBridge !== false;
    d.ledgerShare = [0, 5, 10, 20].includes(Number(r.ledgerShare)) ? Number(r.ledgerShare) : 5;
    d.convoFeed = arr(r.convoFeed).map(normFeed).filter(Boolean).slice(-FEED_MAX);
    return d;
  }
  const isRp = (chat) => String(chat?.mode || "").toLowerCase() === "roleplay";
  const pcWallet = (d) => d.wallets.find((w) => w.who === "pc") || d.wallets[0];
  const npcWallets = (d) => d.wallets.filter((w) => w.who === "npc");
  const money = (d, n) => `${fmt(n)} ${d.pack.currency}`;
  function rewardText(d, q) {
    const parts = [];
    if (q.rewardMoney > 0) parts.push(money(d, q.rewardMoney));
    if (q.rewardStat > 0 && d.pack.statName) parts.push(`${d.pack.statName} ${fmt(q.rewardStat)}`);
    return parts.length ? `보상 ${parts.join(" · ")}` : "";
  }
  /** 시공간 카드 태그 "§RP | 26-11-07 (토) | 21:30 | 장소 | 날씨§"에서 작중 날짜 · 시각을 읽는다. 없으면 null. */
  function readRpTime(text) {
    const m = /§\s*RP\s*\|([^|§\n]{1,40})\|\s*(\d{1,2})\s*:\s*(\d{2})/i.exec(String(text || ""));
    if (!m) return null;
    const raw = m[1].trim();
    let mo = 0, da = 0;
    const a = /(\d{2,4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(raw);
    const b = /\b(\d{2})(\d{2})(\d{2})\b/.exec(raw);
    if (a) { mo = Number(a[2]); da = Number(a[3]); } else if (b) { mo = Number(b[2]); da = Number(b[3]); }
    const hh = Number(m[2]), mm = Number(m[3]);
    if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && hh <= 23 && mm <= 59)) return null;
    const wd = /\(([월화수목금토일])\)/.exec(raw);
    return `${pad(mo)}/${pad(da)}${wd ? ` (${wd[1]})` : ""} ${pad(hh)}:${pad(mm)}`;
  }
  function addLedger(d, entry) {
    const e = { id: uid(), ts: Date.now(), title: str(entry.title, 100), sub: str(entry.sub, 100), amount: signedNum(entry.amount), walletId: entry.walletId, k: entry.k || "" };
    if (d.rpTime) e.rp = str(d.rpTime, 40);
    if (entry.src) e.src = { messageId: str(entry.src.messageId, 256), swipe: Number(entry.src.swipe) || 0 };
    if (entry.g) e.g = entry.g;
    d.ledger.unshift(e);
    d.ledger = d.ledger.slice(0, CAP.ledger);
  }
  function addBag(d, name, qty) {
    const hit = d.bag.find((b) => b.name === name);
    if (hit) hit.qty += qty;
    else d.bag.push({ id: uid(), name, qty });
    d.bag = d.bag.slice(-CAP.bag);
  }
  const deliveryLabel = (x) => `${x.itemName}${x.qty > 1 ? ` ${x.qty}개` : ""}`;

  /** 돈 흐름 표시 안내 한 줄. 괄호 안에 지금 통장 이름들. */
  function moneyMarkLine(d) {
    const names = d.wallets.map((w) => w.name).join(", ");
    return `이야기 속에서 돈이 실제로 오갔을 때만 답장 맨 끝에 한 줄씩 덧붙이세요: [송금: 보내는 사람 → 받는 사람 금액 | 이유] / [입금: 이름 금액 | 이유] / [출금: 이름 금액 | 이유]. 이름은 통장 이름(${names}), 금액은 숫자만. 임무 보상과 최근 거래는 이미 반영되니 빼세요.`;
  }
  /** RP에 숨김으로 보낼 내용. 보내지 않을 때는 "". 정보만 담고, 장면을 시작하라는 지시는 넣지 않는다. */
  function buildContext(d) {
    if (!d || !d.send) return "";
    const cur = d.pack.currency;
    const L = [CTX_HEAD, `화폐: ${cur}`];
    for (const w of d.wallets) L.push(`${w.name}${w.who === "pc" ? "(사용자 캐릭터)" : ""} 잔고: ${fmt(w.balance)} ${cur}`);
    for (const w of d.wallets) {
      const s = w.salary;
      if (!s || !(s.amount > 0)) continue;
      L.push(`${w.name} 월급: ${s.when || "정해진 날"}, ${s.from ? `${s.from}에서 ` : ""}${fmt(s.amount)} ${cur}${d.autoMoney ? ` (이야기 속 날짜가 그날이 되면 한 번만 [입금: ${w.name} ${s.amount} | 월급]을 붙이세요)` : ""}`);
    }
    if (d.autoMoney) L.push(moneyMarkLine(d));
    if (d.pack.statName) L.push(`${d.pack.statName}: ${fmt(d.stat)}`);
    if (d.bag.length) L.push(`가방: ${d.bag.slice(0, 12).map((b) => `${b.name} ×${b.qty}`).join(", ")}${d.bag.length > 12 ? ` 외 ${d.bag.length - 12}종` : ""}`);
    const activeQuests = d.quests.filter((x) => x.status === "active").slice(0, 5);
    for (const q of activeQuests) {
      const inside = [q.giver, rewardText(d, q)].filter(Boolean).join(", ");
      const about = String(q.desc || "").replace(/\s+/g, " ").trim().slice(0, 160);
      L.push(`지금 진행 중인 임무: ${q.title}${inside ? ` (${inside})` : ""}${about ? ` — 할 일: ${about}` : ""}`);
    }
    if (activeQuests.length) L.push(QUEST_MARK_LINE);
    for (const x of d.deliveries) {
      L.push(x.stage === 2 ? `주문한 ${deliveryLabel(x)}이(가) 조리를 마치고 이번 장면에서 도착한다.` : `방금 ${deliveryLabel(x)}을(를) 주문했다. 아직 도착하지 않았다.`);
    }
    if (d.usedNote) L.push(d.usedNote);
    const share = d.ledgerShare || 0;
    if (share > 0 && d.ledger.length) {
      // 통장 내역 최근 N건 (오래된 것부터). 작중 시각이 있으면 그걸, 없으면 현실 날짜.
      const rows = d.ledger.slice(0, share).reverse().map((e) => {
        const who = d.wallets.find((w) => w.id === e.walletId)?.name || "";
        const when = e.rp ? `작중 ${e.rp}` : fmtTime(e.ts);
        return `${when} · ${who ? `${who} ` : ""}${e.title} ${signed(e.amount)}`;
      });
      L.push(`[통장 내역 — 최근 ${rows.length}건]`, ...rows);
    } else {
      const recent = d.ledger.filter((e) => e.k === "buy" || e.k === "xfer").slice(0, 2);
      if (recent.length) L.push(`최근 거래: ${recent.map((e) => `${e.title} ${signed(e.amount)}`).join(" / ")}`);
    }
    const convo = d.convoBridge ? convoBlock(d) : "";
    if (convo) L.push(convo);
    return L.join("\n");
  }
  /** 콘보 문자 묶음(최근 3일, 예상 토큰 FEED_TOKENS까지). 새 줄부터 담고 시간 순서로 쓴다. 없으면 "". */
  function convoBlock(d, now = Date.now()) {
    const lines = arr(d.convoFeed).filter((x) => x && now - x.ts <= FEED_AGE_MS).sort((a, b) => a.ts - b.ts);
    if (!lines.length) return "";
    const me = pcWallet(d)?.name || "나";
    let left = FEED_TOKENS - est(FEED_HEAD) - 1;
    const out = [];
    for (let i = lines.length - 1; i >= 0 && left > 0; i--) {
      const x = lines[i];
      const line = `${fmtTime(x.ts)} ${x.who === "user" ? me : x.name || "상대"}: ${x.text}`;
      const cost = est(line) + 1;
      if (cost <= left) { out.unshift(line); left -= cost; continue; }
      // 가장 새 줄이 너무 길면 잘라서라도 넣고, 그 밖에는 여기서 멈춘다.
      if (!out.length && left > 12) { const cut = truncTokens(line, left - 1); if (cut) out.unshift(cut); }
      break;
    }
    return out.length ? [FEED_HEAD, ...out].join("\n") : "";
  }

  // ── 답장 뒤에 할 일이 남은 방 표시 (이 기기 localStorage, 네트워크 없음) ──
  function readPending() {
    try { const v = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); return arr(v).map(String).slice(-50); } catch { return []; }
  }
  /** 답장 끝의 완료 표시를 살필 방: RP 방 · 숨김 전달 켜짐 · 진행 중인 임무 1개 이상. */
  const watchQuests = (room) => !!room.data && room.data.send && isRp(room.chat) && room.data.quests.some((q) => q.status === "active");
  /** 답장 끝의 돈 흐름 표시를 살필 방: RP 방 · 숨김 전달 켜짐 · 자동 반영 켜짐. */
  const watchMoney = (room) => !!room.data && room.data.send && room.data.autoMoney && isRp(room.chat);
  const hasSuggest = (d) => !!d && d.quests.some((q) => q.status === "active" && !!q.doneSuggested);
  /** 답장이 끝난 뒤 할 일이 있는 방: 배달 · 사용 안내 · 진행 중인 임무 · 돈 흐름 자동 반영. */
  const roomNeeds = (room) => !!room?.data && (room.data.deliveries.length > 0 || !!room.data.usedNote || watchQuests(room) || watchMoney(room));
  function markPending(room) {
    const need = roomNeeds(room);
    try {
      const list = readPending();
      const has = list.includes(room.id);
      if (need !== has) localStorage.setItem(PENDING_KEY, JSON.stringify(need ? [...list, room.id].slice(-50) : list.filter((x) => x !== room.id)));
    } catch {}
    markBridge(room);
    syncAlert(room);
  }
  // ── 콘보 다리를 쓰는 방 표시 (이 기기 localStorage, 네트워크 없음) ──
  /** 이 RP 방이 다리로 읽을 콘보: 엔진의 연결된 채팅 → 없으면 메시지 탭에서 마지막으로 고른 콘보 → 없으면 "". */
  function bridgeConvo(room) {
    const linked = str(room?.chat?.connectedChatId, 256);
    if (linked) return linked;
    const picked = readMap(MSG_PICK_KEY)[room?.id];
    return typeof picked === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(picked) ? picked : "";
  }
  /** 다리가 도는 방: RP 방 · 주머니 있음 · RP에 전달 켜짐 · 콘보 다리 켜짐 · 읽을 콘보가 있음. */
  const bridgeOn = (room) => !!room?.data && room.data.send && room.data.convoBridge && isRp(room.chat) && !!bridgeConvo(room);
  /** RP 방 id → 읽을 콘보 id 를 기억해 둔다(새로고침 뒤 이 방을 아직 안 읽었을 때 쓰는 표시). */
  function markBridge(room) {
    const want = bridgeOn(room) ? bridgeConvo(room) : "";
    const map = readMap(BRIDGE_KEY);
    const has = typeof map[room.id] === "string" ? map[room.id] : "";
    if (want === has) return;
    delete map[room.id];
    if (want) map[room.id] = want;
    writeMap(BRIDGE_KEY, map, 50);
  }
  // ── 완료 제안 알림 (이 기기 localStorage, 네트워크 없음) ──
  function readAlert() {
    try { const v = JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"); return arr(v).map(String).slice(-50); } catch { return []; }
  }
  function syncAlert(room) {
    const need = hasSuggest(room.data);
    try {
      const list = readAlert();
      const has = list.includes(room.id);
      if (need !== has) localStorage.setItem(ALERT_KEY, JSON.stringify(need ? [...list, room.id].slice(-50) : list.filter((x) => x !== room.id)));
    } catch {}
    updateFab();
  }
  /** 지금 들어가 있는 방에 완료 제안이 있는지. 읽어 둔 방은 메모리 값, 아니면 localStorage 표시. */
  function alertFor(chatId) {
    if (!chatId) return false;
    const room = state.rooms.get(chatId);
    if (room && room.data) return hasSuggest(room.data);
    return readAlert().includes(chatId);
  }
  function updateFab() {
    if (!fab) return;
    const activeId = readActiveId();
    const on = alertFor(activeId);
    // 돈 흐름 알림: 이 창이 떠 있는 동안 메모리에만. 창을 열어 안내를 보면 사라진다(금빛 점만, 깜빡임 없음).
    const moneyOn = !on && !!state.rooms.get(activeId)?.moneyNote;
    if (on) fab.setAttribute("data-alert", "quest"); else if (moneyOn) fab.setAttribute("data-alert", "money"); else fab.removeAttribute("data-alert");
    // 새 콘보 메시지: 왼쪽 위 작은 점(임무 · 돈 흐름 표시와 따로, 깜빡임 없음).
    const msgN = msgTotal();
    if (msgN > 0) fab.setAttribute("data-msg", "1"); else fab.removeAttribute("data-msg");
    fab.setAttribute("aria-label", `${on ? "주머니 열기 (끝난 것 같은 임무가 있어요)" : moneyOn ? "주머니 열기 (RP 속 돈 흐름을 반영했어요)" : "주머니 열기"}${msgN > 0 ? ` · 새 메시지 ${msgN}개` : ""}`);
  }

  // ── 임무 완료 표시 ──
  // [임무 완료: 제목] · ［임무완료：제목］ · [퀘스트 완료 제목] 등. 대괄호/전각 괄호, 띄어쓰기, 쌍점은 너그럽게 받는다.
  const MARK_SP = "[ \\t\\u00a0\\u3000]*";
  const MARK_SRC = `[\\[［]${MARK_SP}(?:임무|퀘스트)${MARK_SP}완료${MARK_SP}[:：]?${MARK_SP}([^\\]］\\n]{1,120}?)${MARK_SP}[\\]］]`;
  const markRe = () => new RegExp(MARK_SRC, "g");
  const collapse = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const unquote = (s) => collapse(s).replace(/^["'‘’“”「」『』*_]+|["'‘’“”「」『』*_]+$/g, "").trim();
  /** 글 안의 모든 완료 표시 제목. */
  function findMarkers(content) {
    const out = [];
    for (const m of String(content || "").matchAll(markRe())) { const t = unquote(m[1]); if (t) out.push(t); }
    return out;
  }
  /** 표시 제목 → 진행 중인 임무. 띄어쓰기를 정리한 뒤 똑같으면 그것, 아니면 대소문자 무시 포함 관계. 못 찾으면 버린다. */
  function matchQuests(titles, quests) {
    const hits = [];
    for (const t of titles) {
      const n = collapse(t), low = n.toLowerCase();
      const q = quests.find((x) => collapse(x.title) === n) || (low.length >= 2 ? quests.find((x) => {
        const xl = collapse(x.title).toLowerCase();
        return xl.length >= 2 && (xl.includes(low) || low.includes(xl));
      }) : null);
      if (q && !hits.includes(q)) hits.push(q);
    }
    return hits;
  }
  /** 완료 표시만 지운다. 표시만 있던 줄은 줄째로, 글 뒤에 붙은 표시는 표시만. 다른 글자는 건드리지 않고 끝 공백만 정리. */
  function stripMarkers(content, reFn = markRe) {
    const src = String(content || "");
    if (!reFn().test(src)) return src;
    const lines = [];
    for (const line of src.split("\n")) {
      if (!reFn().test(line)) { lines.push(line); continue; }
      const rest = line.replace(reFn(), "");
      if (!rest.replace(/[\s*_~`]/g, "")) continue;
      lines.push(rest.replace(/[ \t 　]+$/, ""));
    }
    return lines.join("\n").trimEnd();
  }

  // ── 돈 흐름 표시 ──
  // [송금: 레오 → 미아 3만 | 저녁값] · ［입금：레오 2,400실링｜월급］ · [출금 나 2천5백] 등.
  const MONEY_SRC = `[\\[［]${MARK_SP}(송금|입금|출금)${MARK_SP}[:：]?${MARK_SP}([^\\]］\\n]{1,200}?)${MARK_SP}[\\]］]`;
  const moneyRe = () => new RegExp(MONEY_SRC, "g");
  const anyMarkRe = () => new RegExp(`${MARK_SRC}|${MONEY_SRC}`, "g");
  const MONEY_ARROW = /\s*(?:→|⇒|➡️?|➔|⟶|－＞|＝＞|-+>|=+>)\s*/;
  const UNIT = { 억: 1e8, 만: 1e4, 천: 1e3, 백: 100 };
  /** 전각 숫자 · 쉼표 · 세로줄을 반각으로. */
  const halfWidth = (s) => String(s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/，/g, ",").replace(/．/g, ".").replace(/｜/g, "|");
  /** "3만" · "2천5백" · "1만 2천" · "2,400" · "1.5만" → 정수. 못 읽으면 0. */
  function evalAmount(expr) {
    let total = 0, any = false;
    for (const m of String(expr).matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([억만천백])?/g)) {
      let raw = m[1].replace(/,/g, "");
      // 단위 없는 "2.400"은 천 단위 점으로 본다.
      if (!m[2] && /^\d{1,3}(\.\d{3})+$/.test(m[1])) raw = m[1].replace(/\./g, "");
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      total += n * (m[2] ? UNIT[m[2]] : 1); any = true;
    }
    return any && Number.isFinite(total) ? Math.round(total) : 0;
  }
  /** "레오 2,400실링" → { name: "레오", amount: 2400 }. 금액은 끝에 있는 숫자 묶음(뒤의 화폐 이름 등은 버림). */
  function nameAmount(s) {
    const m = String(s).match(/^(.*?)\s*((?:\d[\d,.]*\s*[억만천백]?\s*)+)([^\d]{0,24})$/);
    if (!m) return { name: unquote(s), amount: 0 };
    return { name: unquote(m[1].replace(/[+\-:：]+$/, "")), amount: evalAmount(m[2]) };
  }
  /** 글 안의 돈 흐름 표시. 못 읽는 것도 raw와 함께 돌려준다(건너뛴 안내용). */
  function findMoneyMarkers(content) {
    const out = [];
    for (const m of String(content || "").matchAll(moneyRe())) {
      const raw = collapse(m[0]);
      const bodyText = halfWidth(m[2]);
      const bar = bodyText.indexOf("|");
      const main = collapse(bar >= 0 ? bodyText.slice(0, bar) : bodyText);
      const reason = unquote(bar >= 0 ? bodyText.slice(bar + 1) : "").slice(0, 60);
      if (m[1] === "송금") {
        const parts = main.split(MONEY_ARROW);
        if (parts.length !== 2) { out.push({ kind: m[1], raw, bad: "보내는 사람 → 받는 사람을 읽지 못했어요" }); continue; }
        const to = nameAmount(parts[1]);
        out.push({ kind: m[1], raw, from: unquote(parts[0]), to: to.name, amount: to.amount, reason });
      } else {
        const x = nameAmount(main);
        out.push({ kind: m[1], raw, to: x.name, amount: x.amount, reason });
      }
    }
    return out;
  }
  const PC_ALIASES = ["나", "pc", "사용자", "사용자 캐릭터", "내 통장", "플레이어"];
  /** 표시 속 이름 → 통장. 정리한 뒤 똑같으면 그것, 내 통장 별칭, 아니면 대소문자 무시 포함 관계(2글자 이상, 하나일 때만). */
  function matchWallet(d, rawName, personaName) {
    const n = collapse(String(rawName || "").replace(/\s*[(（][^)）]*[)）]\s*$/, "").replace(/\s*(?:의\s*)?통장$/, "")), low = n.toLowerCase();
    if (!n) return null;
    const exact = d.wallets.find((w) => collapse(w.name) === n) || d.wallets.find((w) => collapse(w.name).toLowerCase() === low);
    if (exact) return exact;
    if (PC_ALIASES.includes(low) || (personaName && collapse(personaName).toLowerCase() === low)) return pcWallet(d);
    if (low.length < 2) return null;
    const hits = d.wallets.filter((w) => { const wl = collapse(w.name).toLowerCase(); return wl.length >= 2 && (wl.includes(low) || low.includes(wl)); });
    return hits.length === 1 ? hits[0] : null;
  }
  /** 표시들을 차례로 반영한다. { applied: [...], skipped: [{raw, why}] } */
  function applyMoneyMarkers(d, marks, src, personaName) {
    const applied = [], skipped = [];
    const maxBal = Math.max(0, ...d.wallets.map((w) => w.balance));
    const kindLabel = { 송금: "RP 속 송금", 입금: "RP 속 입금", 출금: "RP 속 출금" };
    for (const mk of marks) {
      const skip = (why) => skipped.push({ raw: mk.raw, why });
      if (mk.bad) { skip(mk.bad); continue; }
      if (!(mk.amount > 0)) { skip("금액을 읽지 못했어요"); continue; }
      if (mk.amount > MONEY_ABSURD && mk.amount > maxBal * 100) { skip("금액이 너무 커요"); continue; }
      const to = matchWallet(d, mk.to, personaName);
      const title = mk.reason || kindLabel[mk.kind];
      const sub = "RP에서 자동 반영";
      if (mk.kind === "송금") {
        const from = matchWallet(d, mk.from, personaName);
        if (!from || !to) { skip(`‘${!from ? mk.from : mk.to}’ 통장을 찾지 못했어요`); continue; }
        if (from === to) { skip("보내는 사람과 받는 사람이 같아요"); continue; }
        if (from.balance < mk.amount) { skip("잔고가 부족해서 반영하지 않았어요"); continue; }
        const g = uid();
        from.balance -= mk.amount; to.balance += mk.amount;
        addLedger(d, { title, sub: `${sub} · ${from.name} → ${to.name}`, amount: -mk.amount, walletId: from.id, k: "auto", src, g });
        addLedger(d, { title, sub: `${sub} · ${from.name} → ${to.name}`, amount: mk.amount, walletId: to.id, k: "auto", src, g });
      } else {
        if (!to) { skip(`‘${mk.to}’ 통장을 찾지 못했어요`); continue; }
        if (mk.kind === "출금") {
          if (to.balance < mk.amount) { skip("잔고가 부족해서 반영하지 않았어요"); continue; }
          to.balance -= mk.amount;
        } else to.balance += mk.amount;
        addLedger(d, { title, sub, amount: mk.kind === "출금" ? -mk.amount : mk.amount, walletId: to.id, k: "auto", src });
      }
      applied.push(mk);
    }
    return { applied, skipped };
  }
  /** 자동 반영 되돌리기: 잔고를 거꾸로 돌리고 내역(송금이면 묶인 두 줄)을 지운다. 잔고가 모자라면 하지 않는다. */
  function undoAuto(room, entry) {
    const d = room.data;
    if (!d) return;
    const group = entry.g ? d.ledger.filter((e) => e.k === "auto" && e.g === entry.g) : [entry];
    for (const e of group) {
      const w = d.wallets.find((x) => x.id === e.walletId);
      if (w && e.amount > 0 && w.balance < e.amount) return fail(`${w.name}의 잔고가 ${money(d, e.amount)}보다 적어서 되돌릴 수 없어요. 설정에서 잔고를 직접 고쳐 주세요.`);
    }
    const ids = new Set(group.map((e) => e.id));
    edit(room, (x) => {
      for (const e of group) { const w = x.wallets.find((y) => y.id === e.walletId); if (w) w.balance = num(w.balance - e.amount); }
      x.ledger = x.ledger.filter((e) => !ids.has(e.id));
    }, `‘${entry.title}’ 자동 반영을 되돌렸어요.`);
  }

  // ── 상태 ──
  const state = {
    activeId: "", viewId: "", open: false, menuOpen: false, tab: "wallet", busy: "", status: "", statusAt: 0,
    rooms: new Map(), chatList: null,
    filter: "all", wact: null, shopId: "", buy: null, questForm: false, editShopId: "", confirm: null, setup: null, salary: null,
  };
  let draft = {};
  const dget = (k, def = "") => (k in draft ? draft[k] : def);
  let root = null, fab = null, panel = null;

  // 화면 색(이 브라우저, 모든 방 공통). 바꾸면 창과 둥근 버튼이 함께 바뀐다.
  function readTone() { try { return localStorage.getItem(TONE_KEY) === "paper" ? "paper" : "ink"; } catch { return "ink"; } }
  let tone = "ink";
  function setTone(next) {
    tone = next === "paper" ? "paper" : "ink";
    try { localStorage.setItem(TONE_KEY, tone); } catch {}
    if (root) root.setAttribute("data-tone", tone);
    markSaved("tone");
    render();
  }
  function readActiveId() {
    try { const v = localStorage.getItem(ACTIVE_KEY); return v && /^[A-Za-z0-9_-]{1,256}$/.test(v) ? v : ""; } catch { return ""; }
  }

  /** 한 방을 GET 한 번으로 불러온다. 저장 대기 중인 방은 서버 값으로 덮지 않는다. */
  async function loadRoom(id) {
    let room = state.rooms.get(id);
    if (room && (room.saveTimer != null || room.saving)) return room;
    const chat = await api(`chats/${enc(id)}`);
    if (!isRecord(chat)) throw new Error("방 정보를 읽지 못했어요.");
    const raw = parseRecord(chat.metadata)[DATA_KEY];
    let data = null, ownerNote = false;
    if (isRecord(raw) && raw.ownerChatId && raw.ownerChatId !== id) ownerNote = true;
    else { data = normalize(raw, id); if (data) data.ownerChatId = id; }
    if (!room) { room = { id, saveTimer: null, saving: false, again: false, people: null, lore: null }; state.rooms.set(id, room); }
    Object.assign(room, { chat, data, ownerNote });
    markPending(room);
    return room;
  }

  function scheduleSave(room) {
    if (!room || !room.data) return;
    if (room.saveTimer != null) timers.clear(room.saveTimer);
    room.saveTimer = timers.set(() => { room.saveTimer = null; void flush(room); }, SAVE_MS);
  }
  function flushNow(room) {
    if (room?.saveTimer == null) return;
    timers.clear(room.saveTimer); room.saveTimer = null; void flush(room);
  }
  /** 숨김 메시지 맞추기 → PATCH 한 번. 월드 팩이 없는 방은 절대 쓰지 않는다. */
  async function flush(room) {
    const d = room.data;
    if (!d) return;
    if (room.saving) { room.again = true; return; }
    room.saving = true;
    try {
      try { await syncContext(room, d); } catch (e) { log.warn("[주머니] 숨김 메시지 반영 실패", e); setStatus(`RP에 전달하지 못했어요: ${e.message || e}`); }
      if (room.data !== d) return;
      d.ownerChatId = room.id;
      await api(`chats/${enc(room.id)}/metadata`, { method: "PATCH", body: { [DATA_KEY]: clone(d) } });
    } catch (e) {
      log.warn("[주머니] 저장 실패", e); setStatus(`저장하지 못했어요: ${e.message || e}`);
    } finally {
      room.saving = false;
      if (room.again) { room.again = false; scheduleSave(room); }
      // 구매 버튼의 ‘결제 중’은 이 저장이 끝날 때까지 보인다.
      if (room.saveTimer == null && !room.saving) buyFxSaved(room);
      softRender();
    }
  }
  /** 내용이 바뀌었을 때만: 예전 숨김 메시지 삭제 → 새로 만들기. 비면 삭제만. */
  async function syncContext(room, d) {
    if (!isRp(room.chat)) return;
    const content = buildContext(d);
    const outdated = content !== d.contextText || (!!content && !d.contextMessageId) || (!content && !!d.contextMessageId);
    if (!outdated) return;
    if (d.contextMessageId) {
      const old = d.contextMessageId;
      try { await api(`chats/${enc(room.id)}/messages/${enc(old)}?trash=false`, { method: "DELETE" }); }
      catch (e) { if (e.status !== 404) throw e; }
      d.contextMessageId = ""; d.contextText = "";
    }
    if (content) {
      const created = await api(`chats/${enc(room.id)}/messages`, { method: "POST", body: { role: "system", characterId: null, content, extra: { hiddenFromUser: true, jumeoni: true } } });
      const id = str(created?.id, 256);
      if (!id) throw new Error("메시지 id를 돌려받지 못했어요.");
      d.contextMessageId = id;
    }
    d.contextText = content;
  }

  // ── 답장 맞추기: 배달 한 단계 넘기기 · 사용 안내 지우기 · 임무 완료 · 돈 흐름 표시 살피기 (할 게 있을 때만) ──
  // 엔진의 답장 끝 신호(marinara:generation-complete)가 오지 않는 때가 있어서, 신호가 아니라 실제 최근 메시지를 보고 맞춘다.
  // 같은 답장(메시지 id#스와이프)은 한 번만 처리하므로 몇 번을 불러도 결과가 같다.
  const reconQ = new Map(); // 방 id → 진행 중인 맞추기
  const reconAt = new Map(); // 방 id → 마지막으로 맞추기를 시작한 때
  const composer = { armed: true, tries: 0, last: "" }; // 입력칸 계기: 새로고침 직후 · 보낸 뒤에만 켜진다
  const replyKey = (m) => `${String(m.id)}#${Math.max(0, Math.round(Number(m.activeSwipeIndex) || 0))}`;
  const keyMsgId = (k) => k.slice(0, k.lastIndexOf("#"));
  function onGenerationComplete(chatId) { return reconcile(chatId, "event"); }
  /** 한 방에 한 번에 하나씩. 신호(event)는 진행 중인 것이 끝난 뒤 다시 돌고, 다른 계기는 진행 중인 것에 맡긴다. */
  function reconcile(chatId, reason) {
    const prev = reconQ.get(chatId);
    if (prev && reason !== "event") return prev;
    const p = (prev || Promise.resolve()).then(() => runReconcile(chatId, reason))
      .catch((e) => { log.warn("[주머니] 답장 맞추기 실패", e); return 0; })
      .finally(() => { if (reconQ.get(chatId) === p) reconQ.delete(chatId); });
    reconQ.set(chatId, p);
    return p;
  }
  /** 최근 메시지(오래된 것 먼저)에서 아직 처리하지 않은 답장을 고른다. 네트워크 없음.
   *  turn = 이야기가 한 번 진행된 답장(배달 · 사용 안내를 넘긴다): 숨김 메시지를 마지막으로 쓴 뒤에 온 답장.
   *  숨김 메시지가 목록에 없으면 가장 새 답장만. 이미 처리한 메시지의 새 스와이프(다시 생성)도 turn.
   *  turn이 아닌 처리 안 한 답장은 표시가 있을 때만 표시를 살핀다. */
  function planReplies(d, list) {
    const msgs = arr(list).filter((m) => isRecord(m) && m.id != null && String(m.id));
    const seen = new Set(d.processedReplies);
    const seenIds = new Set(d.processedReplies.map(keyMsgId));
    const ctxIdx = d.contextMessageId ? msgs.findIndex((m) => String(m.id) === d.contextMessageId) : -1;
    const asst = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.role === "assistant" && typeof x.m.content === "string");
    // 기준점: 숨김 메시지와 이미 처리한 답장 중 가장 나중 것. 그보다 뒤에 온 답장만 이야기가 진행된 답장이다.
    let anchor = ctxIdx;
    for (const x of asst) if (seenIds.has(String(x.m.id)) && x.i > anchor) anchor = x.i;
    const newest = asst[asst.length - 1];
    const out = [];
    for (const x of asst) {
      const key = replyKey(x.m);
      if (seen.has(key)) continue;
      let turn = anchor >= 0 ? x.i > anchor : x === newest;
      if (!turn && x === newest && seenIds.has(String(x.m.id))) turn = true;
      // 1.3.0에서 옮겨 온 데이터: 기준점이 안 보이면 이미 넘긴 답장일 수 있어 배달은 넘기지 않는다.
      if (turn && anchor < 0 && d.prBase) turn = false;
      out.push({ msg: x.m, key, turn });
    }
    return out;
  }
  /** 할 일이 남은 방만 최근 메시지 4개를 GET 1번. 새로 처리한 답장 수를 돌려준다. */
  async function runReconcile(chatId, reason) {
    reconAt.set(chatId, Date.now());
    let room = state.rooms.get(chatId);
    if (!room || !room.data) {
      // 새로고침 뒤라 이 방을 아직 안 읽었으면, 할 일이 남았다고 표시된 방만 한 번 읽는다.
      if (!readPending().includes(chatId)) { updateFab(); return 0; }
      room = await loadRoom(chatId);
    }
    const d = room.data;
    if (!d || !roomNeeds(room)) { markPending(room); return 0; }
    const list = await api(`chats/${enc(chatId)}/messages?limit=${RECON_LIMIT}`);
    if (room.data !== d) return 0;
    const plan = planReplies(d, list);
    d.prBase = false;
    let changed = false, count = 0;
    // 작중 시각: 최근 답장 중 시공간 카드 태그가 있는 가장 나중 것 (서버 호출 없이, 이미 읽은 메시지에서)
    for (const m of arr(list)) {
      if (!isRecord(m) || m.role !== "assistant") continue;
      const t = readRpTime(m.content);
      if (t && t !== d.rpTime) { d.rpTime = t; changed = true; }
    }
    const arrived = [], notes = [];
    for (const c of plan) {
      const wq = watchQuests(room), wm = watchMoney(room);
      const titles = wq ? findMarkers(c.msg.content) : [];
      const marks = wm ? findMoneyMarkers(c.msg.content) : [];
      if (!c.turn && !titles.length && !marks.length) continue;
      count += 1;
      if (c.turn && (d.deliveries.length || d.usedNote)) {
        const rest = [];
        for (const x of d.deliveries) {
          if (x.stage === 1) { x.stage = 2; rest.push(x); }
          else { addBag(d, x.itemName, x.qty); arrived.push(deliveryLabel(x)); }
        }
        d.deliveries = rest;
        d.usedNote = "";
        changed = true;
      }
      d.processedReplies = [...d.processedReplies.filter((k) => k !== c.key), c.key].slice(-CAP.replies);
      if (titles.length || marks.length) {
        try {
          const res = await applyReplyMarkers(room, d, c.msg, c.key, titles, marks, wq, wm);
          if (res.changed) changed = true;
          notes.push(...res.notes);
        } catch (e) { log.warn("[주머니] 답장 끝 표시를 살피지 못했어요", e); }
        if (room.data !== d) return count;
      }
    }
    if (count && chatId === readActiveId()) { composer.armed = false; composer.tries = 0; }
    const here = state.open && state.viewId === chatId;
    if (arrived.length && here) notes.unshift(`${arrived.join(", ")} 배달이 도착해서 가방에 넣었어요.`);
    if (notes.length && here) setStatus(notes.join(" "));
    markPending(room);
    if (changed) { scheduleSave(room); softRender(); }
    void reason;
    return count;
  }
  /** 답장 하나의 표시. 임무 완료 표시(wq) → 진행 중인 임무에 제안만(상태 · 보상은 그대로). 돈 흐름 표시(wm) → 잔고에 바로 반영(되돌리기 가능).
   *  그 답장에서 살핀 종류의 표시만 PATCH 한 번으로 지운다. */
  async function applyReplyMarkers(room, d, msg, seenKey, titles, marks, wq, wm) {
    const msgId = String(msg.id);
    const swipe = Number(seenKey.slice(seenKey.lastIndexOf("#") + 1)) || 0;
    const names = [];
    for (const q of matchQuests(titles, d.quests.filter((x) => x.status === "active"))) {
      if (q.suggestSeen === seenKey) continue;
      q.doneSuggested = msgId; q.suggestSeen = seenKey;
      names.push(q.title);
    }
    const moneyRes = marks.length ? applyMoneyMarkers(d, marks, { messageId: msgId, swipe }, room.people?.pc?.name || "") : null;
    // 엔진 화면의 메시지 고치기와 같은 PATCH { content }. 지금 보이는 스와이프에만 반영되고 다른 스와이프는 그대로다.
    const next = stripMarkers(msg.content, wq && wm ? anyMarkRe : wm ? moneyRe : markRe);
    if (next !== msg.content && next.trim()) {
      try { await api(`chats/${enc(room.id)}/messages/${enc(msgId)}`, { method: "PATCH", body: { content: next } }); }
      catch (e) { log.warn("[주머니] 답장 끝 표시를 지우지 못했어요", e); }
    }
    const notes = [];
    if (moneyRes && (moneyRes.applied.length || moneyRes.skipped.length)) {
      const parts = [];
      if (moneyRes.applied.length) parts.push(`RP에서 돈 흐름 ${moneyRes.applied.length}건을 반영했어요. 지갑 내역에서 되돌릴 수 있어요.`);
      if (moneyRes.skipped.length) parts.push(`${moneyRes.skipped.length}건은 반영하지 않았어요: ${moneyRes.skipped.slice(0, 3).map((s) => `${s.raw} (${s.why})`).join(" / ")}`);
      const note = parts.join(" ");
      notes.push(note);
      if (!(state.open && state.viewId === room.id)) { room.moneyNote = note; updateFab(); }
    }
    if (names.length) notes.push(`${names.map((t) => `‘${t}’`).join(", ")} 임무가 끝난 것 같아요. 퀘스트 탭에서 확인해 주세요.`);
    return { changed: names.length > 0 || !!moneyRes, notes };
  }
  /** 지금 방에 할 일이 남았고 마지막 맞추기에서 4초가 지났을 때만(입력칸 · 탭 돌아오기 · 창 열기). */
  function reconcileActive(reason) {
    const id = readActiveId();
    if (!id) return null;
    const room = state.rooms.get(id);
    const need = room && room.data ? roomNeeds(room) : readPending().includes(id);
    if (!need || reconQ.has(id) || Date.now() - (reconAt.get(id) || 0) < RECON_GAP_MS) return null;
    return reconcile(id, reason);
  }
  const isComposer = (el) => !!el && el.tagName === "TEXTAREA" && !(root && root.contains(el)) && String(el.getAttribute("placeholder") || "").includes("응답을 입력");
  /** 채팅 입력칸(capture). 보낸 뒤(엔진이 칸을 비웠거나 Enter) 켜지고, 그 뒤 처음 입력할 때 한 번 맞춘다. */
  function onComposerKey(e) {
    const ta = e?.target;
    if (!isComposer(ta)) return;
    const val = String(ta.value || "");
    const prev = composer.last;
    composer.last = val;
    // 콘보 다리: 방을 옮겼거나 보낸 뒤(칸이 비면) 새 메시지를 쓰기 시작할 때 한 번.
    const act = readActiveId();
    if (bridge.armFor !== act) { bridge.armFor = act; bridge.arm = true; }
    if (prev.trim() && !val.trim()) { composer.armed = true; composer.tries = 0; bridge.arm = true; }
    // 보내는 순간에는 맞추지 않는다(답장이 아직 없고, 숨김 메시지를 이때 바꾸면 안 된다). 다음 입력부터.
    if (e.type === "keydown" && e.key === "Enter" && !e.isComposing && val.trim()) { composer.armed = true; composer.tries = 0; bridge.arm = true; return; }
    // 아래 답장 맞추기를 먼저 걸어 두고(같은 처리 안에서), 다리는 그다음에 돈다.
    if (bridge.arm && val.trim()) { bridge.arm = false; void Promise.resolve().then(() => bridgeActive("composer")); }
    if (!composer.armed) return;
    const p = reconcileActive("composer");
    if (!p) return;
    composer.tries += 1;
    if (composer.tries >= COMPOSER_TRIES) composer.armed = false;
  }

  // ── 콘보 다리 (1.7.0): 엔진의 연결된 채팅은 콘보 → RP 방향으로 읽지 않아서, 콘보 최근 문자를 숨김 메시지에 넣는다 ──
  // at: RP 방 id → 마지막으로 콘보를 읽은 때 · seen: RP 방 id → { convoId, at, last }(콘보 목록의 마지막 메시지 시각 비교용)
  const bridge = { at: new Map(), seen: new Map(), q: new Map(), later: null, arm: true, armFor: "" };
  onCleanup(() => { if (bridge.later != null) timers.clear(bridge.later); bridge.later = null; });
  /** 콘보 메시지 하나 → 문자 한 줄. 숨김 · 시스템 · 내레이션 · 빈 글은 null. 캐릭터 이름은 기억해 둔 것만(네트워크 없음). */
  function feedFromMsg(raw, room, convoId) {
    const n = normMsg(raw);
    if (!n.id || n.hidden || (n.role !== "user" && n.role !== "assistant")) return null;
    const d = room.data;
    let name = "", body = "";
    if (n.role === "user") { name = pcWallet(d)?.name || ""; body = n.content; } // 내 문자는 예전처럼(줄바꿈은 띄어쓰기로)
    else {
      if (n.characterId) {
        const cached = msg.names.get(n.characterId);
        name = (cached && cached !== "캐릭터" ? cached : "")
          || d.wallets.find((w) => w.characterId && w.characterId === n.characterId)?.name
          || room.people?.chars.find((c) => c.id === n.characterId)?.name || "";
      }
      // 메신저와 같은 화자 나누기: 시간 표시 · 아는 이름 머리를 지우고, 다른 화자 묶음만 "이름: "을 붙인다.
      const known = convoKnown(msgConvo(convoId)?.characterIds, n.characterId);
      if (name && !known.has(normMatch(name))) known.set(normMatch(name), { name, display: "" });
      const own = { name, display: msg.alias.get(n.characterId) || "" };
      const ownKeys = new Set([normMatch(name), normMatch(own.display)].filter(Boolean));
      const label = (sp) => { const k = known.get(normMatch(sp)); return k ? [k.name, k.display].filter(Boolean).map(normMatch) : [normMatch(sp)]; };
      body = convoGroups(n.content, own, known).map((g) => {
        const t = g.lines.map((l) => l.trim()).join(" / ");
        return !g.speaker || g.own || label(g.speaker).some((k) => ownKeys.has(k)) ? t : `${g.speaker}: ${t}`;
      }).join(" / ");
    }
    return normFeed({ id: n.id, who: n.role === "user" ? "user" : "char", name, text: body, ts: tms(n.createdAt) || Date.now() });
  }
  /** 같은 id는 하나로(새 값으로, 이름을 모르면 예전 이름 유지) · 3일 지난 줄 버림 · 시간 순서로 마지막 FEED_MAX줄. 바뀌었으면 true. */
  function mergeFeed(d, items, now = Date.now()) {
    const before = JSON.stringify(d.convoFeed);
    const byId = new Map(arr(d.convoFeed).map((x) => [x.id, x]));
    for (const x of items) {
      if (!x) continue;
      const old = byId.get(x.id);
      byId.set(x.id, old && !x.name && old.name ? { ...x, name: old.name } : x);
    }
    d.convoFeed = [...byId.values()].filter((x) => now - x.ts <= FEED_AGE_MS)
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(-FEED_MAX);
    return JSON.stringify(d.convoFeed) !== before;
  }
  /** 문자 줄을 방에 넣는다. 바뀌었을 때만 저장(+ 숨김 메시지). now면 800ms 묶기 없이 바로 맞춘다. */
  function feedApply(room, items, now) {
    if (!bridgeOn(room) || !mergeFeed(room.data, items)) return false;
    scheduleSave(room);
    if (now) flushNow(room);
    return true;
  }
  /** 메시지 탭에서 보낸 · 받은 문자(message_saved)를 그 RP 방에 바로 넣는다(호출 없음). 그 방이 읽는 콘보일 때만. */
  function bridgePush(rpId, convoId, raw) {
    const room = state.rooms.get(rpId);
    if (!room || !bridgeOn(room) || bridgeConvo(room) !== convoId) return;
    feedApply(room, [feedFromMsg(raw, room, convoId)], false);
  }
  /** 한 방에 한 번에 하나씩. */
  function bridgeRun(chatId, reason) {
    if (!chatId) return Promise.resolve(false);
    const prev = bridge.q.get(chatId);
    if (prev) return prev;
    const p = runBridge(chatId, reason).catch((e) => { log.warn("[주머니] 콘보 문자를 읽지 못했어요", e); return false; })
      .finally(() => { if (bridge.q.get(chatId) === p) bridge.q.delete(chatId); });
    bridge.q.set(chatId, p);
    return p;
  }
  const bridgeActive = (reason) => bridgeRun(readActiveId(), reason);
  /** 콘보 답장 끝 신호가 4초 안에 또 오면, 남은 시간 뒤에 한 번만 다시 본다(한 번짜리 타이머). */
  function bridgeLater(chatId, ms) {
    if (bridge.later != null) return;
    bridge.later = timers.set(() => { bridge.later = null; void bridgeRun(chatId, "later"); }, Math.max(0, ms) + 50);
  }
  /** 콘보 최근 메시지 BRIDGE_LIMIT개를 GET 1번(4초에 1번까지). 새 줄이 있을 때만 저장 · 숨김 메시지. */
  async function runBridge(chatId, reason) {
    await Promise.resolve();
    // 답장 맞추기가 돌고 있으면 끝난 뒤에(숨김 메시지를 먼저 옮기면 그 답장을 이야기 진행으로 못 볼 수 있다).
    const rq = reconQ.get(chatId);
    if (rq) await rq;
    let room = state.rooms.get(chatId);
    if (room ? !bridgeOn(room) : typeof readMap(BRIDGE_KEY)[chatId] !== "string") return false;
    const sure = reason === "event" || reason === "later"; // 콘보가 답장을 끝냈다는 신호
    const gap = RECON_GAP_MS - (Date.now() - (bridge.at.get(chatId) || 0));
    if (gap > 0) { if (reason === "event") bridgeLater(chatId, gap); return false; }
    if (!room) {
      // 새로고침 뒤라 이 방을 아직 안 읽었으면, 다리 표시가 있는 방만 한 번 읽는다.
      bridge.at.set(chatId, Date.now());
      room = await loadRoom(chatId);
      if (!bridgeOn(room)) return false;
    }
    const convoId = bridgeConvo(room);
    // 콘보 목록을 마지막으로 읽은 뒤보다 나중에 받아 둔 목록이 있고, 그 마지막 메시지 시각이 그대로면 읽지 않는다.
    const seen = bridge.seen.get(chatId), c = msgConvo(convoId);
    if (!sure && seen && seen.convoId === convoId && c && c.last && msg.listAt >= seen.at && tms(c.last) <= tms(seen.last)) return false;
    bridge.at.set(chatId, Date.now());
    const list = arr(await api(`chats/${enc(convoId)}/messages?limit=${BRIDGE_LIMIT}`)).filter((m) => isRecord(m) && m.id != null);
    if (!bridgeOn(room) || bridgeConvo(room) !== convoId) return false;
    let last = "";
    for (const m of list) if (tms(m.createdAt) > tms(last)) last = String(m.createdAt);
    bridge.seen.set(chatId, { convoId, at: Date.now(), last });
    return feedApply(room, list.map((m) => feedFromMsg(m, room, convoId)), true);
  }

  // ── 세계관 자료 모으기 (누를 때만) ──
  function chatCharacterIds(chat) {
    let raw = chat?.characterIds;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = []; } }
    return Array.from(new Set(arr(raw).filter((v) => typeof v === "string" && v.length > 0)));
  }
  function cardOf(row) {
    const c = parseRecord(row?.data), inner = parseRecord(c.data);
    const pick = (k) => text(c[k] || inner[k] || "", 8000);
    return { name: str(row?.name || c.name || inner.name, 40), description: pick("description"), personality: pick("personality"), scenario: pick("scenario"), first_mes: pick("first_mes") };
  }
  function cardText(card, withScene) {
    const parts = [`이름: ${card.name || "(이름 없음)"}`];
    if (card.description) parts.push(`설명: ${card.description}`);
    if (card.personality) parts.push(`성격: ${card.personality}`);
    if (withScene && card.scenario) parts.push(`시나리오: ${card.scenario}`);
    if (withScene && card.first_mes) parts.push(`첫 장면: ${card.first_mes.slice(0, 400)}`);
    return parts.join("\n");
  }
  /** 캐릭터 카드(들)와 페르소나. 방마다 한 번만 읽고 이 창이 떠 있는 동안 기억한다. */
  async function gatherPeople(room) {
    if (room.people) return room.people;
    const chat = room.chat;
    const chars = [];
    const ids = chatCharacterIds(chat).slice(0, CAP.wallets - 1);
    for (let i = 0; i < ids.length; i++) {
      let card = { name: "", description: "", personality: "", scenario: "", first_mes: "" };
      try { card = cardOf(await api(`characters/${enc(ids[i])}`)); } catch (e) { log.warn("[주머니] 캐릭터 카드를 읽지 못했어요", e); }
      const name = card.name || `캐릭터 ${i + 1}`;
      chars.push({ id: ids[i], name, text: cardText({ ...card, name }, true) });
    }
    const pc = { name: "나", text: "" };
    try {
      if (chat.personaId) {
        const p = parseRecord(await api(`characters/personas/${enc(String(chat.personaId))}`));
        pc.name = str(p.name, 40) || "나";
        pc.text = cardText({ name: pc.name, description: text(p.description, 8000), personality: text(p.personality, 8000) }, false);
      } else if (chat.personaCharacterId) {
        const card = cardOf(await api(`characters/${enc(String(chat.personaCharacterId))}`));
        pc.name = card.name || "나";
        pc.text = cardText({ ...card, name: pc.name }, false);
      }
    } catch (e) { log.warn("[주머니] 페르소나를 읽지 못했어요", e); }
    room.people = { chars, pc };
    return room.people;
  }
  function scopeActive(scope, chatId) {
    const s = parseRecord(scope);
    if (s.mode === "disabled") return false;
    if (s.mode === "specific") return arr(s.chatIds).map((x) => String(x).trim()).includes(chatId);
    return true;
  }
  /** 엔진 클라이언트(chat-lorebooks.ts)와 같은 방식으로 이 방에 켜진 로어북을 고른다. */
  function activeLorebooks(all, chat) {
    const meta = parseRecord(chat.metadata);
    const strs = (v) => arr(v).filter((x) => typeof x === "string");
    const pinned = new Set(strs(meta.activeLorebookIds)), excluded = new Set(strs(meta.excludedLorebookIds));
    const charIds = chatCharacterIds(chat);
    return all.filter((lb) => {
      if (!isRecord(lb) || !lb.id || excluded.has(lb.id)) return false;
      if (lb.enabled === false || lb.enabled === "false" || !scopeActive(lb.scope, chat.id)) return false;
      if (pinned.has(lb.id)) return true;
      if (lb.isGlobal === true || lb.isGlobal === "true") return true;
      if (arr(lb.characterIds).some((id) => charIds.includes(id)) || (!!lb.characterId && charIds.includes(lb.characterId))) return true;
      if (chat.personaId && (arr(lb.personaIds).includes(chat.personaId) || lb.personaId === chat.personaId)) return true;
      return lb.chatId === chat.id;
    });
  }
  /** 켜진 로어북의 켜진 항목(상시 항목 먼저). 방마다 한 번만 읽는다. */
  async function gatherLore(room) {
    if (room.lore) return room.lore;
    const res = await api("lorebooks");
    const all = Array.isArray(res) ? res : arr(res?.items || res?.lorebooks);
    const books = activeLorebooks(all, room.chat).slice(0, CAP.books);
    const entries = [];
    for (const lb of books) {
      let list = [];
      try { list = arr(await api(`lorebooks/${enc(String(lb.id))}/entries`)); } catch (e) { log.warn("[주머니] 로어북 항목을 읽지 못했어요", e); }
      for (const e of list) {
        if (!isRecord(e) || e.enabled === false || e.enabled === "false") continue;
        const body = text(e.content, 12000);
        if (!body) continue;
        const name = str(e.name, 80);
        entries.push({ constant: e.constant === true || e.constant === "true", text: name ? `[${name}] ${body}` : body });
      }
    }
    room.lore = { books: books.length, entries: [...entries.filter((e) => e.constant), ...entries.filter((e) => !e.constant)] };
    return room.lore;
  }
  function fitLore(entries, budget) {
    const out = [];
    let used = 0;
    for (const e of entries) {
      const t = est(e.text) + 1;
      if (used + t <= budget) { out.push(e.text); used += t; continue; }
      const rem = budget - used;
      if (rem > 40) { const cut = truncTokens(e.text, rem - 1); if (cut) out.push(cut); }
      break;
    }
    return { text: out.join("\n"), count: out.length };
  }
  const SETUP_SYSTEM = "너는 롤플레이 방의 세계관 자료를 읽고, 그 세계에 어울리는 지갑·상점·임무 틀을 만드는 조수야. 반드시 JSON 객체 하나만 출력해. 코드블록, 설명, 주석은 쓰지 마.";
  function buildSetupPrompt(people, lore) {
    const names = people.chars.map((c) => c.name);
    const n = Math.max(1, people.chars.length);
    const perChar = Math.floor(Math.min(1000, 2400 / n));
    const head = [
      "아래 자료를 읽고 이 세계관에 맞는 값을 한국어로 채워 줘.",
      "",
      "출력 형식(JSON 객체 하나):",
      '{"currency":"화폐 이름","statName":"성장 수치 이름(없으면 빈 문자열)","pcBalance":0,"pcSalary":null,"npcBalances":[{"name":"캐릭터 이름","balance":0,"salary":{"amount":0,"when":"매월 25일","from":"지급처"}}],"shops":[{"name":"가게 이름","kind":"shop 또는 delivery","desc":"한 줄 설명","items":[{"name":"품목","price":0,"stock":5}]}],"quests":[{"title":"임무 제목","giver":"의뢰인","rewardMoney":0,"rewardStat":0,"desc":"한 줄 설명"}]}',
      "",
      "규칙:",
      '- shops는 2~4곳, 가게마다 items는 3~6개. 음식을 시켜 먹는 것이 어울리는 세계관이면 kind가 "delivery"인 가게를 한 곳 이상 넣어. 나머지는 "shop".',
      "- 모든 품목에 stock(재고, 1~999 정수)을 넣어. 귀한 물건은 1~3, 흔한 물건은 5~10. 배달 음식은 하루에 만들 수 있는 양이야.",
      "- quests는 정확히 3개. statName이 빈 문자열이면 rewardStat은 0.",
      "- 가격, 잔고, 보상은 0 이상의 정수. 서로 화폐 가치가 맞게 잡아.",
      "- pcBalance는 사용자 캐릭터의 시작 잔고, npcBalances는 아래 등장인물 각각의 시작 잔고야. 카드에 드러난 형편(부유함, 빈털터리 등)을 반영해.",
      "- salary(pcSalary)는 그 인물의 직업에 어울리는 정기 수입이야. amount는 정수, when은 받는 때(예: 매월 25일, 매주 금요일), from은 주는 곳. 정기 수입이 없거나 어울리지 않으면 null.",
      names.length ? `- npcBalances의 name은 다음 이름을 그대로 써: ${names.join(", ")}` : "- 등장인물이 없으면 npcBalances는 빈 배열.",
      "",
      "# 등장인물",
      ...(people.chars.length ? people.chars.map((c) => truncTokens(c.text, perChar)) : ["(없음)"]),
      "",
      "# 사용자 캐릭터",
      people.pc.text ? truncTokens(people.pc.text, 600) : `이름: ${people.pc.name}`,
      "",
      "# 세계관 자료",
    ].join("\n");
    const budget = SETUP_TOKEN_CAP - est(SETUP_SYSTEM) - est(head) - 30;
    const fit = fitLore(lore.entries, Math.max(0, budget));
    const user = `${head}\n${fit.text || "(연결된 로어북 항목이 없어요. 등장인물 자료만으로 만들어 줘.)"}`;
    return { system: SETUP_SYSTEM, user, tokens: est(SETUP_SYSTEM) + est(user), loreUsed: fit.count, loreTotal: lore.entries.length, books: lore.books };
  }
  /** 모델 답에서 JSON 하나를 꺼낸다(코드블록 제거 → 첫 { … 마지막 }). 못 읽으면 null. */
  function parseJson(out) {
    const s = String(out || "").replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
    const tries = [s];
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
    const c = s.indexOf("["), e = s.lastIndexOf("]");
    if (c >= 0 && e > c) tries.push(s.slice(c, e + 1));
    for (const t of tries) { try { const v = JSON.parse(t); if (isRecord(v) || Array.isArray(v)) return v; } catch {} }
    return null;
  }
  // ── AI 연결 고르기 (모든 방 공통, 이 브라우저 localStorage) ──
  function readAiPref() {
    try {
      const p = parseRecord(JSON.parse(localStorage.getItem(AI_KEY) || "null"));
      const connectionId = typeof p.connectionId === "string" ? p.connectionId.trim().slice(0, 256) : "";
      return connectionId ? { connectionId, label: str(p.label, 160) } : { connectionId: "", label: "" };
    } catch { return { connectionId: "", label: "" }; }
  }
  const ai = { pref: readAiPref(), list: null, busy: false, tried: false, error: "" };
  function saveAiPref(connectionId, label) {
    ai.pref = connectionId ? { connectionId, label: str(label, 160) } : { connectionId: "", label: "" };
    try {
      if (connectionId) localStorage.setItem(AI_KEY, JSON.stringify(ai.pref));
      else localStorage.removeItem(AI_KEY);
    } catch {}
  }
  const aiLabel = () => (ai.pref.connectionId ? (ai.pref.label || "설정에서 고른 연결") : AI_DEFAULT_LABEL);
  const aiUseText = () => `쓸 AI 연결: ${aiLabel()}`;
  /** GET /api/connections 한 번. 설정 탭을 처음 열 때와 목록 버튼을 누를 때만 부른다. */
  async function loadConns() {
    if (ai.busy) return;
    ai.busy = true; ai.tried = true; ai.error = "";
    try {
      const res = await api("connections");
      if (!Array.isArray(res)) throw new Error("연결 목록을 읽지 못했어요.");
      ai.list = res.filter((c) => isRecord(c) && typeof c.id === "string" && c.id && !NON_CHAT_PROVIDERS.includes(c.provider))
        .map((c) => { const name = str(c.name, 80) || "이름 없는 연결", model = str(c.model, 80); return { id: c.id, label: model ? `${name} · ${model}` : name }; });
      const hit = ai.list.find((c) => c.id === ai.pref.connectionId);
      if (hit && hit.label !== ai.pref.label) saveAiPref(hit.id, hit.label);
    } catch (e) { ai.error = `연결 목록을 불러오지 못했어요: ${e.message || e}`; }
    finally { ai.busy = false; refreshAiPickers(); }
  }
  /** AI 한 번 부르기(generate/raw). 설정에서 고른 연결이 있으면 그것을, 없으면 방에 연결된 모델을 쓴다. */
  async function callAi(room, system, user, maxTokens) {
    const chosen = ai.pref.connectionId;
    const connectionId = chosen || str(room.chat.connectionId, 256);
    if (!connectionId) throw new Error("이 방에 연결된 모델이 없어요. 채팅 설정에서 연결을 고르거나, 주머니의 ‘AI 연결’에서 골라 주세요.");
    let payload;
    try {
      payload = await api("generate/raw", {
        method: "POST", timeoutMs: MODEL_TIMEOUT_MS,
        body: { connectionId, runId: `jmn-${uid()}`, streaming: false, messages: [{ role: "system", content: system }, { role: "user", content: user }], parameters: { maxTokens } },
      });
    } catch (e) {
      // 고른 연결이 사라졌거나 못 쓰게 됐을 때: 방의 모델로 몰래 바꾸지 않고 다시 고르게 한다.
      if (chosen && e?.status === 404) throw new Error(`고른 AI 연결(${aiLabel()})을 찾을 수 없어요. 지워졌을 수 있어요. 설정의 ‘AI 연결’에서 다시 골라 주세요.`);
      if (chosen && e?.status === 400) throw new Error(`고른 AI 연결(${aiLabel()})을 쓸 수 없어요(${e.message || e}). 설정의 ‘AI 연결’에서 다시 골라 주세요.`);
      throw e;
    }
    if (isRecord(payload) && typeof payload.error === "string") throw new Error(payload.error);
    const out = typeof payload === "string" ? payload : String(payload?.content || "");
    if (!out.trim()) throw new Error("모델이 빈 응답을 돌려줬어요.");
    return out;
  }

  /** 월드 팩 만들기. json이 비어 있으면 빈 틀(화폐 "골드", 잔고 0). */
  function applySetup(room, json, people, opts) {
    const j = parseRecord(json);
    const prev = room.data;
    const keep = !!(opts.rerun && !opts.reset && prev);
    const d = keep ? prev : freshData(room.id);
    if (!keep && prev) { d.contextMessageId = prev.contextMessageId; d.contextText = prev.contextText; d.send = prev.send; d.autoMoney = prev.autoMoney; d.processedReplies = prev.processedReplies; d.prBase = prev.prBase; d.convoBridge = prev.convoBridge; d.convoFeed = prev.convoFeed; }
    d.pack = {
      currency: str(j.currency, 20) || (keep ? prev.pack.currency : "골드"),
      statName: str(j.statName, 30),
      shops: arr(j.shops).map((s) => normShop(s, STOCK_DEFAULT)).filter((s) => s.name).slice(0, CAP.shops),
    };
    const balances = arr(j.npcBalances);
    const npcHit = (c, i) => balances.find((b) => str(b?.name, 40) === c.name) || balances.find((b) => { const nm = str(b?.name, 40); return nm && (nm.includes(c.name) || c.name.includes(nm)); }) || balances[i];
    const npcBalance = (c, i) => num(npcHit(c, i)?.balance);
    /** 월급이 있으면 붙인다(금액이 0이면 버림). */
    const withSalary = (w, raw) => { const s = normSalary(raw); if (s && s.amount > 0) w.salary = s; return w; };
    if (keep) {
      people.chars.forEach((c, i) => {
        const w = d.wallets.find((x) => x.characterId === c.id);
        if (w) { if (!w.salary) withSalary(w, npcHit(c, i)?.salary); }
        else if (d.wallets.length < CAP.wallets) d.wallets.push(withSalary({ id: uid(), who: "npc", characterId: c.id, name: c.name, balance: npcBalance(c, i) }, npcHit(c, i)?.salary));
      });
      const pc = pcWallet(d);
      if (!pc.salary) withSalary(pc, j.pcSalary);
    } else {
      d.wallets = [withSalary({ id: uid(), who: "pc", name: people.pc.name || "나", balance: num(j.pcBalance) }, j.pcSalary),
        ...people.chars.map((c, i) => withSalary({ id: uid(), who: "npc", characterId: c.id, name: c.name, balance: npcBalance(c, i) }, npcHit(c, i)?.salary))];
    }
    const offered = arr(j.quests).map((q) => normQuest(q, "offered")).filter((q) => q.title).slice(0, 5);
    d.quests = keep ? [...offered, ...prev.quests.filter((q) => q.status !== "offered")].slice(0, CAP.quests) : offered;
    room.data = d; room.ownerNote = false;
    markPending(room);
    scheduleSave(room);
  }

  async function startGather(room, opts) {
    const s = { roomId: room.id, phase: "gathering", rerun: !!opts.rerun, reset: !!opts.reset, error: "" };
    state.setup = s; state.confirm = null; setStatus(""); render();
    try {
      const people = await gatherPeople(room);
      const lore = await gatherLore(room);
      if (state.setup !== s) return;
      Object.assign(s, buildSetupPrompt(people, lore), { phase: "confirm" });
    } catch (e) {
      if (state.setup !== s) return;
      s.phase = "error"; s.error = `자료를 읽지 못했어요: ${e.message || e}`;
    }
    render();
  }
  async function runSetupAi(room) {
    const s = state.setup;
    if (!s || s.phase !== "confirm") return;
    s.phase = "calling"; render();
    try {
      const json = parseJson(await callAi(room, s.system, s.user, 4000));
      if (!isRecord(json)) throw new Error("AI의 답을 JSON으로 읽지 못했어요.");
      if (state.setup !== s) return;
      applySetup(room, json, room.people, s);
      state.setup = null; state.tab = "wallet";
      setStatus("세계관을 읽어서 틀을 만들었어요. 설정 탭에서 언제든 고칠 수 있어요.");
    } catch (e) {
      if (state.setup !== s) return;
      s.phase = "error"; s.error = `만들지 못했어요: ${e.message || e}`;
    }
    render();
  }
  async function startEmpty(room) {
    state.busy = "setup"; setStatus(""); render();
    try {
      const people = await gatherPeople(room);
      applySetup(room, null, people, { rerun: false, reset: false });
      state.setup = null; state.tab = "wallet";
      setStatus("빈 틀로 시작했어요. 설정 탭에서 화폐, 잔고, 가게를 채워 보세요.");
    } catch (e) { setStatus(`시작하지 못했어요: ${e.message || e}`); }
    finally { state.busy = ""; render(); }
  }
  async function askQuests(room) {
    const d = room.data;
    state.busy = "ai"; setStatus(""); render();
    try {
      const lore = await gatherLore(room);
      const system = "너는 롤플레이 세계관에 어울리는 임무(퀘스트)를 만드는 조수야. 반드시 JSON 객체 하나만 출력해. 코드블록, 설명, 주석은 쓰지 마.";
      const user = [
        "아래 세계관에 어울리는 새 임무를 한국어로 1~2개 만들어 줘. 이미 있는 임무와 겹치지 않게 해.",
        '출력 형식: {"quests":[{"title":"임무 제목","giver":"의뢰인","rewardMoney":0,"rewardStat":0,"desc":"한 줄 설명"}]}',
        `화폐: ${d.pack.currency}${d.pack.statName ? ` / 성장 수치: ${d.pack.statName}` : " / 성장 수치 없음(rewardStat은 0)"}`,
        `사용자 캐릭터 잔고: ${money(d, pcWallet(d).balance)} (보상 크기를 정할 때 참고)`,
        `등장인물: ${npcWallets(d).map((w) => w.name).join(", ") || "(없음)"}`,
        `가게: ${d.pack.shops.map((s) => s.name).join(", ") || "(없음)"}`,
        `이미 있는 임무: ${d.quests.map((q) => q.title).slice(0, 30).join(" / ") || "(없음)"}`,
        "",
        "# 세계관 자료",
        fitLore(lore.entries, QUEST_LORE_CAP).text || "(없음)",
      ].join("\n");
      const json = parseJson(await callAi(room, system, user, 2000));
      const got = arr(Array.isArray(json) ? json : json?.quests).map((q) => normQuest(q, "offered")).filter((q) => q.title).slice(0, 2);
      if (!got.length) throw new Error("AI의 답에서 임무를 읽지 못했어요.");
      edit(room, (x) => { x.quests = [...got, ...x.quests].slice(0, CAP.quests); }, `새 임무 ${got.length}개를 받았어요.`);
    } catch (e) { setStatus(`새 퀘스트를 받지 못했어요: ${e.message || e}`); }
    finally { state.busy = ""; render(); }
  }
  // ── 월급 추측하기 (누를 때만: 카드 · 페르소나 읽기(방마다 처음 1번) → 예상 토큰 확인 → AI 1번) ──
  const SALARY_SYSTEM = "너는 롤플레이 등장인물의 직업과 정기 수입을 추측하는 조수야. 반드시 JSON 객체 하나만 출력해. 코드블록, 설명, 주석은 쓰지 마.";
  /** 로어북은 넣지 않는다(토큰 절약). 지금 틀 요약 + 카드 · 페르소나(짧게). */
  function buildSalaryPrompt(d, people) {
    const n = Math.max(1, people.chars.length);
    const perChar = Math.floor(Math.min(500, 2000 / n));
    const prices = d.pack.shops.flatMap((s) => s.items.slice(0, 3).map((i) => `${i.name} ${fmt(i.price)}`)).slice(0, 8);
    const user = [
      "아래 인물마다 직업에 어울리는 정기 수입(월급 등)을 한국어로 추측해 줘.",
      '출력 형식: {"salaries":[{"name":"통장 이름","salary":{"amount":0,"when":"매월 25일","from":"주는 곳"}}]}',
      "규칙:",
      "- name은 아래 통장 이름을 그대로 써.",
      "- amount는 0 이상의 정수. 지금 잔고와 물가에 맞게. when은 받는 때(예: 매월 25일, 매주 금요일), from은 주는 곳.",
      "- 정기 수입이 없거나 어울리지 않으면 salary는 null.",
      "",
      `화폐: ${d.pack.currency}`,
      `물가(품목 가격): ${prices.join(", ") || "(없음)"}`,
      `통장(잔고): ${d.wallets.map((w) => `${w.name}${w.who === "pc" ? "(사용자 캐릭터)" : ""} ${fmt(w.balance)}`).join(", ")}`,
      "",
      "# 등장인물",
      ...(people.chars.length ? people.chars.map((c) => truncTokens(c.text, perChar)) : ["(없음)"]),
      "",
      "# 사용자 캐릭터",
      people.pc.text ? truncTokens(people.pc.text, 400) : `이름: ${people.pc.name}`,
    ].join("\n");
    return { system: SALARY_SYSTEM, user, tokens: est(SALARY_SYSTEM) + est(user) };
  }
  async function startSalaryGuess(room) {
    const g = { roomId: room.id, phase: "gathering", error: "" };
    state.salary = g; setStatus(""); render();
    try {
      const people = await gatherPeople(room);
      if (state.salary !== g || !room.data) return;
      Object.assign(g, buildSalaryPrompt(room.data, people), { phase: "confirm" });
    } catch (e) {
      if (state.salary !== g) return;
      g.phase = "error"; g.error = `자료를 읽지 못했어요: ${e.message || e}`;
    }
    render();
  }
  /** 비어 있는 월급 칸만 채운다(금액이 있는 통장은 그대로). */
  async function runSalaryGuess(room) {
    const g = state.salary;
    if (!g || g.phase !== "confirm") return;
    const d = room.data;
    g.phase = "calling"; render();
    try {
      const json = parseJson(await callAi(room, g.system, g.user, SALARY_TOKENS));
      const rows = arr(Array.isArray(json) ? json : json?.salaries);
      if (!rows.length) throw new Error("AI의 답에서 월급을 읽지 못했어요.");
      if (state.salary !== g || room.data !== d) return;
      const filled = [];
      edit(room, (x) => {
        for (const r of rows) {
          const w = matchWallet(x, str(r?.name, 40), room.people?.pc?.name || "");
          const s = normSalary(r?.salary);
          if (!w || !s || !(s.amount > 0) || (w.salary && w.salary.amount > 0) || filled.includes(w)) continue;
          w.salary = s; filled.push(w);
        }
      });
      state.salary = null;
      setStatus(filled.length ? `월급을 ${filled.length}개 채웠어요: ${filled.map((w) => w.name).join(", ")}. 아래 칸에서 고칠 수 있어요.` : "채울 월급이 없었어요(비어 있는 칸이 없거나 AI가 정기 수입이 없다고 봤어요).");
    } catch (e) {
      if (state.salary !== g) return;
      g.phase = "error"; g.error = `월급을 추측하지 못했어요: ${e.message || e}`;
    }
    render();
  }
  // ── 다 팔린 품목 채우기 (산 결과로 재고가 0이 됐을 때 · ‘새 물건 들이기’를 눌렀을 때만, 한 번에 하나씩) ──
  const restock = { queue: [], current: null };
  const newItems = new Map(); // 새로 들어온 품목 id → 들어온 때(화면 표시용, 메모리에만)
  const restockBusy = (itemId) => restock.current?.itemId === itemId || restock.queue.some((x) => x.itemId === itemId);
  /** 지금 들어가 있는 방에서만 줄을 세운다. 같은 품목은 두 번 넣지 않는다. */
  function queueRestock(room, shopId, itemId) {
    if (!room || room.id !== state.activeId || restockBusy(itemId)) return false;
    restock.queue.push({ roomId: room.id, shopId, itemId });
    if (!restock.current) void runRestock();
    else softRender();
    return true;
  }
  const RESTOCK_SYSTEM = "너는 롤플레이 세계관의 가게에 새로 들어올 물건 하나를 정하는 조수야. 반드시 JSON 객체 하나만 출력해. 코드블록, 설명, 주석은 쓰지 마.";
  function buildRestockPrompt(d, shop, it) {
    const others = shop.items.filter((x) => x.id !== it.id && x.stock !== 0).map((x) => `${x.name} ${fmt(x.price)}`);
    const recent = shop.soldOutHistory.slice(-10);
    const delivery = shop.kind === "delivery";
    return [
      "다 팔린 물건 자리에 이 가게에 어울리는 새 물건을 한국어로 딱 하나 만들어 줘.",
      '출력 형식: {"name":"품목","price":0,"stock":5,"note":"한 줄 설명(선택)"}',
      `화폐: ${d.pack.currency}${d.pack.statName ? ` / 성장 수치: ${d.pack.statName}` : ""}`,
      `가게: ${shop.name} (${delivery ? "배달 음식점" : "상점"})${shop.desc ? ` — ${shop.desc}` : ""}`,
      `지금 있는 물건(가격): ${others.join(", ") || "(없음)"}`,
      `다 팔린 물건: ${it.name} ${fmt(it.price)}`,
      `최근에 다 팔린 물건: ${recent.join(", ") || "(없음)"}`,
      "규칙:",
      "- 지금 있는 물건, 최근에 다 팔린 물건과 겹치지 않는 새 물건.",
      "- price는 0 이상의 정수. 이 가게 물건들의 가격대에 맞게.",
      `- stock은 1~${STOCK_MAX} 정수. 귀한 물건은 1~3, 흔한 물건은 5~10.${delivery ? " 배달 음식은 하루에 만들 수 있는 양." : ""}`,
    ].join("\n");
  }
  /** AI 답에서 품목 하나. 못 읽으면 던진다. */
  function parseRestock(out) {
    let j = parseJson(out);
    if (Array.isArray(j)) j = j[0];
    j = parseRecord(j);
    if (isRecord(j.item)) j = j.item;
    else if (Array.isArray(j.items)) j = parseRecord(j.items[0]);
    const it = normItem(j, STOCK_DEFAULT);
    if (!it.name) throw new Error("AI의 답에서 새 물건을 읽지 못했어요.");
    return it;
  }
  async function runRestock() {
    if (restock.current) return;
    while (restock.queue.length) {
      const job = restock.queue.shift();
      restock.current = job;
      softRender();
      try {
        const room = state.rooms.get(job.roomId);
        const d = room?.data;
        const shop = d?.pack.shops.find((s) => s.id === job.shopId);
        const it = shop?.items.find((x) => x.id === job.itemId);
        if (!it || it.stock !== 0) continue;
        const oldName = it.name;
        let fresh;
        try { fresh = parseRestock(await callAi(room, RESTOCK_SYSTEM, buildRestockPrompt(d, shop, it), RESTOCK_TOKENS)); }
        catch (e) {
          if (room.data === d) setStatus(`‘${oldName}’ 자리에 새 물건을 들이지 못했어요: ${e.message || e}`);
          continue;
        }
        // 기다리는 동안 방 데이터가 바뀌었거나(지우기 · 다시 읽기) 직접 채웠으면 버린다.
        if (room.data !== d) continue;
        const idx = shop.items.findIndex((x) => x.id === job.itemId);
        if (idx < 0 || shop.items[idx].stock !== 0 || !d.pack.shops.includes(shop)) continue;
        shop.items[idx] = fresh;
        newItems.set(fresh.id, Date.now()); // 상점 탭을 떠날 때까지 ‘NEW’ 표시
        if (state.buy?.itemId === job.itemId) state.buy = null;
        setStatus(`‘${oldName}’${josa(oldName, "이", "가")} 다 팔려서 ‘${fresh.name}’이(가) 새로 들어왔어요.`);
        markPending(room);
        scheduleSave(room);
      } catch (e) {
        log.warn("[주머니] 새 물건 들이기 실패", e);
      } finally {
        restock.current = null;
      }
    }
    softRender();
  }

  async function wipeRoom(room) {
    const d = room.data;
    if (!d) return;
    if (room.saving) { setStatus("저장하는 중이에요. 잠시 뒤에 다시 눌러 주세요."); render(); return; }
    if (room.saveTimer != null) { timers.clear(room.saveTimer); room.saveTimer = null; }
    state.busy = "wipe"; setStatus(""); render();
    try {
      if (d.contextMessageId) {
        try { await api(`chats/${enc(room.id)}/messages/${enc(d.contextMessageId)}?trash=false`, { method: "DELETE" }); }
        catch (e) { if (e.status !== 404) throw e; }
        d.contextMessageId = ""; d.contextText = "";
      }
      await api(`chats/${enc(room.id)}/metadata`, { method: "PATCH", body: { [DATA_KEY]: null } });
      room.data = null; state.setup = null; state.tab = "wallet";
      markPending(room);
      setStatus("이 방의 주머니 데이터를 지웠어요.");
    } catch (e) { setStatus(`지우지 못했어요: ${e.message || e}`); }
    finally { state.busy = ""; state.confirm = null; render(); }
  }

  // ── 페르소나 비밀 (‘페르소나 비밀’ 0.3.x–0.5.0 확장과 같은 데이터 형식: 같은 태그 · 같은 dynamicState 키) ──
  // 비밀은 방이 아니라 페르소나에 딸린 로어북에 들어간다. 지침 항목은 상태마다 한 개만 켜 둔다.
  const PS_OWNER_TAG = "persona-secrets-managed";
  const PS_STATE_KEY = "personaSecrets";
  const PS_INSTANCE_KEY = "__personaSecretsInstanceV1";
  const PS_WARN = "‘페르소나 비밀’ 확장이 켜져 있어요. 같은 비밀을 두 곳에서 고치면 서로 덮어쓸 수 있으니 그 확장은 꺼 주세요.";
  const PS_STATES = ["OFF", "FORESHADOW", "REVEALED"];
  // ↓ 페르소나 비밀 0.5.0과 글자 하나까지 같은 지침. 바꾸면 기존 로어북의 지침 항목이 다시 PATCH 된다.
  const FORESHADOW_RULES = `[SECRET KNOWLEDGE — FORESHADOW]
아래 [비밀 · 복선] 항목은 아직 서사에서 공개되지 않은 작가용 설정이다. 캐릭터의 현재 지식이 아니다.

목표: 비밀을 바로 밝히지 않으면서, 캐릭터들이 의심하고 직접 알아내려 움직이게 만든다. 의심은 행동으로 이어져야 한다.

진행 규칙:
- 장면에 단서가 보이거나 위화감이 생기면, 그것을 알아챈 캐릭터는 그 장면이나 다음 장면 안에 실제 행동을 하나 시도한다. 직접 묻기, 떠보기, 자세히 관찰하기, 뒤를 밟기, 기록이나 소문 찾아보기, 다른 인물에게 물어보기 등.
- 조사의 결과는 부분적이다. 한 번의 조사로는 단서 하나, 모순 하나, 새로운 의문 하나 정도만 얻는다.
- 캐릭터는 지금까지 RP 안에서 실제로 보고 들은 것만 근거로 추측한다. 여러 가능성을 열어 두고, 단서가 쌓이면 의심의 범위를 조금씩 좁힌다.
- 비밀을 가진 쪽이 얼버무리거나 피하는 반응도 새로운 단서가 될 수 있다.
- '드러나는 단서'가 적힌 비밀은 그 흔적을 장면에 자연스럽게 등장시킬 수 있다.

넘지 말 것:
- 비밀의 정답을 서술하거나, 사실상 정답을 말해 버리는 암시를 하지 않는다.
- 캐릭터가 작가용 정보를 추리의 근거로 쓰지 않는다. 꿈, 직감, 독백으로 정답을 우회 공개하지 않는다.
- 단서 하나만으로 정답을 확정하지 않는다.
- 사용자 캐릭터의 반응이나 발견을 대신 정하지 않는다.
- 발각 조건이 정해진 비밀은 그 조건이 실제로 일어나기 전까지 정답이 드러나지 않는다. 그 전에도 의심과 조사는 계속할 수 있다.
- 공개(REVEALED) 전환은 사용자만 한다.`;
  const RULES_STATES = ["FORESHADOW", "REVEALED"];
  const SECRET_HEADERS = { FORESHADOW: "[비밀 · 복선]", REVEALED: "[비밀 · 공개]" };
  const RULES_NAMES = { FORESHADOW: "📜 복선 지침 (자동)", REVEALED: "📜 공개 지침 (자동)" };
  // 엔진은 상시 항목을 order 낮은 순으로 붙인다: 지침(100/102) 바로 뒤에 그 상태의 비밀(101/103).
  const RULE_ORDERS = { FORESHADOW: 100, REVEALED: 102 };
  const REVEALED_RULES = `[SECRET KNOWLEDGE — REVEALED]
아래 정보는 사용자가 공개 상태로 지정한 확정 설정이다.
다만 각 인물이 이 사실을 아는 범위는 실제 공개 장면과 현재 서사에서 얻은 정보에 맞춰야 한다.`;
  const CLUE_MAX = 1000;

  const sec = {
    pend: null, // 바꾸는 중인 상태(화면에서 알약을 먼저 옮겨 두는 용도)
    personas: null, personaErr: "", personaId: "", picked: false, autoFrom: null,
    lorebook: null, secrets: [], rules: [], loadedFor: null, loading: "", error: "",
    expanded: new Set(), form: null, confirmDel: "", busy: false,
  };
  const psApi = (method, path, body) => api(path.replace(/^\//, ""), { method, body });

  function personaIds(book) {
    if (Array.isArray(book?.personaIds) && book.personaIds.length) return book.personaIds.map(String);
    return typeof book?.personaId === "string" && book.personaId ? [book.personaId] : [];
  }
  function ownedBookFor(books, personaId) {
    return books.find((book) => isRecord(book) && Array.isArray(book.tags) && book.tags.includes(PS_OWNER_TAG) && personaIds(book).includes(personaId));
  }
  function normalizeClue(value) {
    return typeof value === "string" ? value.trim().slice(0, CLUE_MAX) : "";
  }
  function secretMeta(entry) {
    const raw = entry?.dynamicState?.[PS_STATE_KEY];
    if (!raw || typeof raw !== "object" || raw.kind === "rules") return null;
    if (typeof raw.originalText !== "string") return null;
    const secretState = PS_STATES.includes(raw.state) ? raw.state : "OFF";
    return { originalText: raw.originalText, state: secretState, clue: normalizeClue(raw.clue) };
  }
  function rulesMeta(entry) {
    const raw = entry?.dynamicState?.[PS_STATE_KEY];
    if (!raw || typeof raw !== "object" || raw.kind !== "rules") return null;
    return RULES_STATES.includes(raw.state) ? { state: raw.state } : null;
  }
  function derivedContent(title, originalText, secretState, clue = "") {
    if (secretState === "OFF") return "";
    const base = `${SECRET_HEADERS[secretState]} ${String(title || "").trim()}\n${originalText.trim()}`;
    const visibleClue = secretState === "FORESHADOW" ? normalizeClue(clue) : "";
    return visibleClue ? `${base}\n드러나는 단서: ${visibleClue}` : base;
  }
  function rulesContent(secretState) {
    const wrapper = secretState === "FORESHADOW" ? FORESHADOW_RULES : REVEALED_RULES;
    return `${wrapper}\n\n아래 ${SECRET_HEADERS[secretState]} 항목들이 이 지침의 대상이다.`;
  }
  const entryPath = (entryId) => `/lorebooks/${enc(sec.lorebook.id)}/entries/${enc(entryId)}`;

  /** 비밀 항목은 짧은 본문, 지침은 상태마다 한 개. 다른 값만 PATCH 한다(이미 맞으면 호출 0번).
   *  예전(0.3.x) 항목처럼 본문에 지침 전체가 들어 있던 것도 여기서 짧은 본문으로 바뀐다. */
  async function syncRules() {
    if (!sec.lorebook) return;
    const counts = { FORESHADOW: 0, REVEALED: 0 };
    for (const item of sec.secrets) {
      const { entry, meta } = item;
      const changes = {};
      const content = derivedContent(entry.name, meta.originalText, meta.state, meta.clue);
      const enabled = meta.state !== "OFF";
      if (entry.content !== content) changes.content = content;
      if (entry.enabled !== enabled) changes.enabled = enabled;
      if (enabled) {
        counts[meta.state] += 1;
        if (entry.order !== RULE_ORDERS[meta.state] + 1) changes.order = RULE_ORDERS[meta.state] + 1;
      }
      if (Object.keys(changes).length) {
        const updated = await psApi("PATCH", entryPath(entry.id), changes);
        item.entry = updated && typeof updated === "object" ? updated : { ...entry, ...changes };
      }
    }
    for (const ruleState of RULES_STATES) {
      const [primary, ...extras] = sec.rules.filter((item) => item.meta.state === ruleState);
      const active = counts[ruleState] > 0;
      const anchor = sec.secrets.find((item) => item.meta.state === ruleState)?.entry;
      const wanted = { content: rulesContent(ruleState), enabled: active, order: RULE_ORDERS[ruleState] };
      if (anchor) {
        for (const key of ["position", "depth", "role"]) if (anchor[key] !== undefined) wanted[key] = anchor[key];
      }
      if (!primary) {
        if (!active) continue;
        const created = await psApi("POST", `/lorebooks/${enc(sec.lorebook.id)}/entries`, {
          name: RULES_NAMES[ruleState],
          ...wanted,
          constant: true,
          keys: [],
          preventRecursion: true,
          excludeFromVectorization: true,
          dynamicState: { [PS_STATE_KEY]: { kind: "rules", state: ruleState, schemaVersion: 2 } },
        });
        if (created && typeof created === "object") sec.rules.push({ entry: created, meta: { state: ruleState } });
      } else {
        const changes = {};
        for (const [key, value] of Object.entries(wanted)) if (primary.entry[key] !== value) changes[key] = value;
        if (Object.keys(changes).length) {
          const updated = await psApi("PATCH", entryPath(primary.entry.id), changes);
          primary.entry = updated && typeof updated === "object" ? updated : { ...primary.entry, ...changes };
        }
      }
      // 같은 상태의 지침이 둘 이상이면 지침 글이 두 번 들어가니 나머지는 꺼 둔다.
      for (const extra of extras) {
        if (extra.entry.enabled === false) continue;
        const updated = await psApi("PATCH", entryPath(extra.entry.id), { enabled: false });
        extra.entry = updated && typeof updated === "object" ? updated : { ...extra.entry, enabled: false };
      }
    }
  }
  async function loadPersonas() {
    const result = await psApi("GET", "/characters/personas/list?limit=1000&offset=0&sort=name");
    const rows = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
    sec.personas = rows.filter((item) => item && typeof item.id === "string");
  }
  /** 고른 페르소나의 비밀 로어북 찾기(GET 1번) → 항목 읽기. 로어북이 없으면 만들지 않는다(처음 저장할 때 만든다). */
  async function loadSelectedPersona() {
    sec.lorebook = null;
    sec.secrets = [];
    sec.rules = [];
    if (!sec.personaId) return;
    const books = await psApi("GET", `/lorebooks?personaId=${enc(sec.personaId)}`);
    sec.lorebook = ownedBookFor(Array.isArray(books) ? books : [], sec.personaId) || null;
    if (!sec.lorebook) return;
    await reloadEntries();
  }
  /** 로어북 항목 GET 1번 → 지침 맞추기. */
  async function reloadEntries() {
    const rows = arr(await psApi("GET", `/lorebooks/${enc(sec.lorebook.id)}/entries`));
    sec.secrets = rows.map((entry) => ({ entry, meta: secretMeta(entry) })).filter((item) => item.meta);
    sec.rules = rows.map((entry) => ({ entry, meta: rulesMeta(entry) })).filter((item) => item.meta);
    await syncRules();
  }
  async function ensureLorebook() {
    if (sec.lorebook) return sec.lorebook;
    const persona = (sec.personas || []).find((item) => item.id === sec.personaId);
    if (!persona) throw new Error("선택한 페르소나를 찾을 수 없습니다.");
    const created = await psApi("POST", "/lorebooks", {
      name: `🔐 비밀 — ${persona.name || "이름 없음"}`,
      description: "Persona Secrets 확장이 관리하는 페르소나 전용 비밀 로어북입니다.",
      personaIds: [persona.id],
      tags: [PS_OWNER_TAG],
      scanDepth: 5,
      tokenBudget: 8192,
      excludeFromVectorization: true,
      enabled: true,
      isGlobal: false,
    });
    if (!isRecord(created) || !created.id) throw new Error("비밀 로어북을 만들지 못했어요.");
    sec.lorebook = created;
    return sec.lorebook;
  }
  async function saveSecret(existing, title, originalText, secretState, clue = "") {
    if (!sec.personaId) throw new Error("먼저 페르소나를 선택해 주세요.");
    if (!title.trim()) throw new Error("비밀 제목을 입력해 주세요.");
    if (!originalText.trim()) throw new Error("비밀 내용을 입력해 주세요.");
    const book = await ensureLorebook();
    const meta = { originalText: originalText.trim(), state: secretState, clue: normalizeClue(clue), schemaVersion: 1 };
    const payload = {
      name: title.trim(),
      content: derivedContent(title, meta.originalText, secretState, meta.clue),
      enabled: secretState !== "OFF",
      ...(secretState !== "OFF" ? { order: RULE_ORDERS[secretState] + 1 } : {}),
      constant: true,
      keys: [],
      preventRecursion: true,
      excludeFromVectorization: true,
      dynamicState: { ...(existing?.dynamicState || {}), [PS_STATE_KEY]: meta },
    };
    if (existing) await psApi("PATCH", `/lorebooks/${enc(book.id)}/entries/${enc(existing.id)}`, payload);
    else await psApi("POST", `/lorebooks/${enc(book.id)}/entries`, payload);
  }
  async function deleteSecret(entry) {
    if (!sec.lorebook) return;
    await psApi("DELETE", `/lorebooks/${enc(sec.lorebook.id)}/entries/${enc(entry.id)}`);
  }
  /** 고친 뒤 다시 읽기. 로어북을 이미 알면 항목만(GET 1번), 아니면 로어북부터. */
  async function secAfterWrite() {
    if (sec.lorebook) await reloadEntries();
    else await loadSelectedPersona();
  }
  const stateLabel = (v) => (v === "FORESHADOW" ? "복선" : v === "REVEALED" ? "공개" : "OFF");
  /** ‘페르소나 비밀’ 확장이 이 페이지에서 돌고 있는지(DOM · window만 본다, 네트워크 없음). */
  function otherSecretsOn() {
    try { return !!(window[PS_INSTANCE_KEY] || document.querySelector(".psx-launcher, .psx-panel, [data-psx-button]")); } catch { return false; }
  }
  /** 비밀 탭을 그릴 때 필요한 것만 불러온다. 이미 있으면 아무것도 부르지 않는다. */
  function secEnsure(room) {
    if (sec.loading || sec.busy) return;
    if (!sec.picked && sec.autoFrom !== room.id) {
      sec.autoFrom = room.id;
      const pid = typeof room.chat?.personaId === "string" ? room.chat.personaId : "";
      if (pid !== sec.personaId) { sec.personaId = pid; sec.loadedFor = null; secResetView(); }
    }
    const needPersonas = sec.personas == null && !sec.personaErr;
    const needEntries = !!sec.personaId && sec.loadedFor !== sec.personaId;
    if (!needPersonas && !needEntries) return;
    sec.loading = needPersonas ? "personas" : "entries";
    sec.error = "";
    void (async () => {
      try {
        if (needPersonas) {
          try { await loadPersonas(); } catch (e) { sec.personas = null; sec.personaErr = `페르소나 목록을 불러오지 못했어요: ${e.message || e}`; }
        }
        const pid = sec.personaId;
        if (pid && sec.loadedFor !== pid) {
          sec.loading = "entries"; sec.loadedFor = pid;
          await loadSelectedPersona();
        }
      } catch (e) { sec.error = `비밀을 불러오지 못했어요: ${e.message || e}`; }
      finally { sec.loading = ""; render(); }
    })();
  }
  function secResetView() {
    sec.form = null; sec.confirmDel = ""; sec.expanded.clear();
    for (const k of ["ps.title", "ps.text", "ps.clue"]) delete draft[k];
  }
  /** 누를 때 하는 일 하나. 하는 동안 다른 비밀 버튼은 막는다. */
  async function secRun(busyMsg, fn, okMsg) {
    if (sec.busy) return false;
    sec.busy = true; setStatus(busyMsg); render();
    let ok = false;
    try { await fn(); ok = true; setStatus(typeof okMsg === "function" ? okMsg() : okMsg || ""); }
    catch (e) { setStatus(e?.message || String(e)); }
    finally { sec.busy = false; render(); }
    return ok;
  }
  function secSetState(item, next) {
    if (item.meta.state === next || sec.busy) return Promise.resolve(false);
    const name = item.entry.name;
    // 저장하는 동안 검은 알약을 먼저 옮겨 둔다(화면만). 실패하면 원래 자리로 돌아간다.
    sec.pend = { id: item.entry.id, state: next };
    return secRun(`${stateLabel(next)} 상태로 바꾸는 중이에요…`, async () => {
      try {
        await saveSecret(item.entry, item.entry.name, item.meta.originalText, next, item.meta.clue);
        await secAfterWrite();
      } finally { sec.pend = null; }
    }, `‘${name}’을(를) ${stateLabel(next)} 상태로 바꿨어요.`);
  }
  /** 추가(item 없음, OFF로 시작) 또는 고치기(상태는 그대로). */
  function secSave(item, title, originalText, clue) {
    return secRun("저장하는 중이에요…", async () => {
      await saveSecret(item ? item.entry : null, title, originalText, item ? item.meta.state : "OFF", clue);
      await secAfterWrite();
      secResetView();
    }, item ? "비밀을 고쳤어요." : "비밀을 추가했어요. 아래에서 복선 · 공개로 바꿀 수 있어요.");
  }
  function secDelete(item) {
    const id = item.entry.id;
    return secRun("지우는 중이에요…", async () => {
      await deleteSecret(item.entry);
      sec.expanded.delete(id); sec.confirmDel = "";
      await secAfterWrite();
    }, "비밀을 지웠어요.");
  }

  // ── 메시지 (콘보 방 메신저) ──
  // RP 방에 있으면서 캐릭터의 콘보(Conversation) 방 메시지를 읽고 보낸다. 콘보 방 설정(연결 · 일정 · 모델)은 그대로 쓴다.
  // 서버 호출: 탭을 열 때 GET /api/chats 1번(창이 떠 있는 동안 기억) + 고른 콘보의 최근 메시지 GET 1번
  //  (+ 처음 보는 캐릭터 이름 GET 1번씩, 기억) + 안 읽음이 있을 때만 DELETE autonomous-unread 1번.
  // 보내기 POST /api/generate 1번(스트림, 그 콘보 방의 AI가 한 번 불림) · 멈추기 POST /api/generate/abort 1번 · 연결하기 POST connect 1번.
  // 새 메시지 알아채기: 엔진의 알림 말풍선이 생기거나 바뀔 때만(MutationObserver), 10초에 1번까지 GET /api/chats.
  const MSG_SEEN_KEY = "marinara.jumeoni.msgSeen.v1"; // 콘보 id → 마지막으로 본 메시지 시각(이 기기)
  const MSG_PICK_KEY = "marinara.jumeoni.msgPick.v1"; // RP 방 id → 마지막으로 고른 콘보 id(이 기기)
  const MSG_PAGE = 30;
  const MSG_THROTTLE_MS = 10000;
  const MSG_MAX_LEN = 20000;
  // 엔진 ChatNotificationBubbles.tsx 의 말풍선 묶음: <div class="pointer-events-none absolute right-3 top-1/2 z-30 …">
  const BUBBLE_CLASSES = ["pointer-events-none", "absolute", "right-3", "top-1/2", "z-30"];
  const BUBBLE_SEL = "div.pointer-events-none.absolute.right-3.z-30.top-1\\/2";
  const MSG_NOTE = "메시지 탭은 콘보 방 설정(연결, 일정, 모델)을 그대로 써요. 보낼 때마다 그 콘보 방의 AI가 한 번 불려요.";
  const msg = {
    convos: null, rpRows: null, listBusy: false, listPromise: null, listErr: "", listStale: false, listAt: 0,
    forRp: "", selId: "", picking: false, showOthers: false, confirmConnect: false, connectBusy: false, fresh: false,
    thread: null, names: new Map(), alias: new Map(), nameReq: new Set(),
    send: null, fail: null, note: null, unread: new Map(), anchor: null,
  };
  const isConvo = (c) => String(c?.mode || "").toLowerCase() === "conversation";
  function readMap(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || "{}"); return isRecord(v) ? v : {}; } catch { return {}; }
  }
  function writeMap(key, obj, cap) {
    try {
      const keys = Object.keys(obj);
      const out = {};
      for (const k of keys.slice(-cap)) if (typeof obj[k] === "string") out[k] = obj[k];
      localStorage.setItem(key, JSON.stringify(out));
    } catch {}
  }
  const tms = (s) => Date.parse(s || "") || 0;
  const msgVisible = () => !!panel && state.open && state.tab === "msg";
  const msgTotal = () => { let n = 0; for (const v of msg.unread.values()) n += v; return n; };
  const msgConvo = (id) => (msg.convos || []).find((c) => c.id === id) || null;
  function normMsg(m) {
    const ex = parseRecord(m?.extra);
    return {
      id: String(m?.id ?? ""), role: str(m?.role, 20), characterId: m?.characterId ? String(m.characterId) : "",
      content: String(m?.content ?? "").slice(0, MSG_MAX_LEN), createdAt: str(m?.createdAt, 40),
      hidden: ex.hiddenFromUser === true, attach: arr(ex.attachments).length,
    };
  }
  const shownMsg = (m) => !m.hidden && (m.role === "user" || m.role === "assistant" || m.role === "narrator");

  // ── 콘보 화자 나누기 (1.7.2): 엔진 shared/utils/speaker-segments.ts · ConversationView.tsx 와 같은 규칙 ──
  // 엔진 text-matching.ts normalizeTextForMatch
  const normMatch = (v) => (typeof v === "string" ? v.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " ") : "");
  const CLOCK_SRC = String.raw`\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?`;
  const FULLDATE_SRC = String.raw`\d{1,2}\.\d{1,2}\.\d{2,4}`;
  const DATETIME_SRC = String.raw`\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\s+${CLOCK_SRC}`;
  const LEAD_TS_RE = new RegExp(String.raw`^([^\S\n]*(?:\[(?:${DATETIME_SRC}|${CLOCK_SRC}|${FULLDATE_SRC})\])\s*)+`, "gm");
  /** 줄 머리의 [HH:MM] · [DD.MM.YYYY] · [DD.MM HH:MM] 를 지운다(엔진 stripLeadingMessageTimestamps). */
  const stripTs = (s) => String(s || "").replace(LEAD_TS_RE, "").trim();
  function angleEnd(v, i, less) {
    const named = less ? "&lt;" : "&gt;";
    if (v.slice(i, i + named.length).toLowerCase() === named) return i + named.length;
    if (!v.startsWith("&#", i)) return -1;
    let c = i + 2;
    const hex = v[c]?.toLowerCase() === "x";
    if (hex) c++;
    while (v[c] === "0") c++;
    const suf = hex ? (less ? "3c;" : "3e;") : less ? "60;" : "62;";
    return v.slice(c, c + suf.length).toLowerCase() === suf ? c + suf.length : -1;
  }
  /** &lt;speaker="…"&gt; 처럼 글자로 바뀐 화자 태그를 되돌린다(엔진 decodeEncodedSpeakerTags). */
  function decodeSpeakerTags(v) {
    let out = "", cur = 0, cand = -1, body = -1;
    for (let i = 0; i < v.length; i++) {
      if (cand < 0) {
        const e = angleEnd(v, i, true);
        if (e < 0) continue;
        cand = i; body = e; i = e - 1;
        continue;
      }
      if (v[i] === "<" || v[i] === ">") { cand = -1; body = -1; continue; }
      const ce = angleEnd(v, i, false);
      if (ce < 0) continue;
      const dec = v.slice(body, i).replace(/&quot;|&#0*34;|&#x0*22;/gi, '"').replace(/&apos;|&#0*39;|&#x0*27;/gi, "'").trim();
      let rep = null;
      if (/^\/\s*speaker\s*$/i.test(dec)) rep = "</speaker>";
      else { const o = dec.match(/^speaker\s*=\s*(["'])([^"']*)\1\s*$/i); if (o?.[2]) rep = `<speaker="${o[2].trim()}">`; }
      if (rep !== null) { out += v.slice(cur, cand) + rep; cur = ce; }
      cand = -1; body = -1; i = ce - 1;
    }
    return out + v.slice(cur);
  }
  /** <speaker="이름">…</speaker> 조각들. 태그가 하나도 없으면 null. 모르는 이름은 내레이션(null). */
  function speakerTagSegs(content, known) {
    const v = decodeSpeakerTags(content);
    const open = '<speaker="', close = "</speaker>";
    const segs = [];
    let last = 0, from = 0, found = false;
    while (from < v.length) {
      const s = v.indexOf(open, from);
      if (s < 0) break;
      const ns = s + open.length, ne = v.indexOf('"', ns);
      if (ne < 0 || v[ne + 1] !== ">") { from = s + 1; continue; }
      const be = v.indexOf(close, ne + 2);
      if (be < 0) break;
      found = true;
      const who = v.slice(ns, ne).trim();
      if (s > last) { const before = v.slice(last, s).trim(); if (before) segs.push({ speaker: null, text: before }); }
      segs.push({ speaker: known.has(normMatch(who)) ? who : null, text: v.slice(ne + 2, be).trim() });
      last = be + close.length; from = last;
    }
    if (last < v.length) { const after = v.slice(last).trim(); if (after) segs.push({ speaker: null, text: after }); }
    return found ? segs : null;
  }
  /** `이름: 글` · `이름:\n글` 줄 머리 조각들(엔진 parseNamePrefixFormat). 아는 이름이 하나도 없으면 null. */
  function namePrefixSegs(content, known, lead) {
    if (!known.size) return null;
    const segs = [];
    let who = null, cur = [], found = false;
    const flush = () => { if (cur.length) segs.push({ speaker: who, text: cur.join("\n") }); };
    for (const line of content.split("\n")) {
      const ci = line.indexOf(":");
      if (ci > 0) {
        const name = line.slice(0, ci).trim();
        const raw = line.slice(ci + 1);
        const same = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if ((same.length === 0 || /^[\t ]/u.test(same)) && known.has(normMatch(name))) {
          flush();
          who = name; cur = [same.replace(/^[\t ]+/u, "")]; found = true;
          continue;
        }
      }
      cur.push(line);
    }
    flush();
    if (!found) return null;
    const vis = segs.filter((s) => s.text.trim());
    const nl = lead ? normMatch(lead) : "";
    if (vis[0]?.speaker === null && nl && known.has(nl)) vis[0] = { ...vis[0], speaker: lead.trim() };
    return vis;
  }
  /** 같은 화자가 이어지면 한 묶음으로(엔진 groupConsecutiveSegments) · 묶음마다 빈 줄 뺀 줄들(splitGroupedSegmentDisplayLines). */
  function groupSegs(segs) {
    const groups = [];
    for (const s of segs) {
      const last = groups[groups.length - 1];
      const t = s.text.replace(/^\n+/, "").replace(/\n+$/, "");
      if (last && last.speaker && s.speaker && normMatch(last.speaker) === normMatch(s.speaker)) last.chunks.push(t);
      else groups.push({ speaker: s.speaker, chunks: [t] });
    }
    return groups.map((g) => ({ speaker: g.speaker, lines: g.chunks.flatMap((c) => c.split(/\r?\n/)).filter((l) => l.trim().length > 0) }));
  }
  const nonBlank = (s) => String(s || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  /** 콘보 방 캐릭터들(+ 이 메시지의 캐릭터)의 이름 · 콘보 표시 이름 → { name, display }. 기억해 둔 것만(네트워크 없음). */
  function convoKnown(ids, ownId) {
    const out = new Map();
    for (const id of Array.from(new Set([...arr(ids), ...(ownId ? [ownId] : [])]))) {
      const nm = msg.names.get(id);
      const name = nm && nm !== "캐릭터" ? nm : "";
      const display = msg.alias.get(id) || "";
      for (const a of [name, display]) {
        if (!a.trim()) continue;
        const k = normMatch(a);
        if (id === ownId || !out.has(k)) out.set(k, { name, display });
      }
    }
    return out;
  }
  /**
   * 메시지 하나 → 화자 묶음 [{ speaker: 이름 | null(내레이션), lines }]. 엔진 콘보 화면과 같은 순서:
   * 시간 표시 지우기 → 맨 앞 "이름:" 줄 지우기 → 화자 태그 → "이름: " 줄 머리 → 둘 다 없으면 빈 줄 · 이름만 있는 줄을 뺀 한 묶음.
   */
  function convoGroups(content, own, known) {
    let c = stripTs(content);
    const ownName = own?.name || "";
    if (ownName) c = c.replace(new RegExp(`^\\s*${ownName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:?\\s*\\n`, "i"), "");
    const keys = new Set(known.keys());
    const lead = (own?.display || "").trim() || ownName || null;
    const segs = speakerTagSegs(c, keys) || namePrefixSegs(c, keys, lead);
    const label = (sp) => { const k = known.get(normMatch(sp)); return (k && (k.display.trim() || k.name)) || sp; };
    if (segs) return groupSegs(segs).filter((g) => g.lines.length).map((g) => ({ speaker: g.speaker ? label(g.speaker) : null, lines: g.lines }));
    const lines = nonBlank(c).filter((l) => !ownName || (l.trim() !== ownName && l.trim() !== `${ownName}:`));
    return lines.length ? [{ speaker: (own?.display || "").trim() || ownName || null, lines, own: true }] : [];
  }

  /** GET /api/chats 1번. 콘보 방 목록과 RP 방 연결 정보를 기억하고 안 읽음 수를 다시 센다. */
  function msgLoadList() {
    if (msg.listPromise) return msg.listPromise;
    msg.listBusy = true; msg.listErr = "";
    msg.listPromise = (async () => {
      try {
        const rows = arr(await api("chats")).filter((c) => isRecord(c) && c.id);
        msg.convos = rows.filter(isConvo).map((c) => ({
          id: String(c.id), name: str(c.name, 60), characterIds: chatCharacterIds(c), connectedChatId: str(c.connectedChatId, 256),
          last: str(c.lastMessageAt, 40), unreadServer: num(parseRecord(c.metadata).autonomousUnreadCount),
        }));
        msg.rpRows = new Map(rows.filter(isRp).map((c) => [String(c.id), { connectedChatId: str(c.connectedChatId, 256), characterIds: chatCharacterIds(c) }]));
        msg.listStale = false; msg.listAt = Date.now();
        msgCount();
      } catch (e) { msg.listErr = `콘보 방 목록을 불러오지 못했어요: ${e.message || e}`; }
      finally { msg.listBusy = false; msg.listPromise = null; }
    })();
    return msg.listPromise;
  }
  /** 목록 값으로 콘보마다 안 읽음 수: 엔진의 autonomousUnreadCount, 없으면 마지막으로 본 뒤 새 메시지가 있으면 1. 네트워크 없음. */
  function msgCount() {
    const seen = readMap(MSG_SEEN_KEY);
    let changed = false;
    const active = readActiveId();
    for (const c of msg.convos || []) {
      if (c.id === active) {
        // 엔진 화면에서 지금 보고 있는 콘보는 읽은 것으로 본다.
        if (c.last && seen[c.id] !== c.last) { seen[c.id] = c.last; changed = true; }
        msg.unread.set(c.id, 0);
        continue;
      }
      if (typeof seen[c.id] !== "string") { seen[c.id] = c.last || ""; changed = true; } // 처음 보는 콘보: 지금까지는 읽은 것으로
      msg.unread.set(c.id, c.unreadServer > 0 ? c.unreadServer : tms(c.last) > tms(seen[c.id]) ? 1 : 0);
    }
    if (changed) writeMap(MSG_SEEN_KEY, seen, 200);
    paintMsgBadges();
  }
  function msgMarkSeen(chatId, iso) {
    if (!iso) return;
    const seen = readMap(MSG_SEEN_KEY);
    if (tms(iso) <= tms(seen[chatId])) return;
    seen[chatId] = iso;
    writeMap(MSG_SEEN_KEY, seen, 200);
  }
  /** 메신저에서 그 콘보를 봤을 때: 본 시각 기록, 안 읽음 0. 엔진에 안 읽음이 남아 있을 때만 DELETE 1번. */
  function msgViewed(chatId) {
    const t = msg.thread && msg.thread.chatId === chatId ? msg.thread : null;
    const c = msgConvo(chatId);
    let newest = "";
    for (const m of t ? t.items : []) if (!m.local && tms(m.createdAt) > tms(newest)) newest = m.createdAt;
    if (c && tms(c.last) > tms(newest)) newest = c.last;
    msgMarkSeen(chatId, newest);
    msg.unread.set(chatId, 0);
    if (c && c.unreadServer > 0) {
      c.unreadServer = 0;
      void api(`chats/${enc(chatId)}/autonomous-unread`, { method: "DELETE" }).catch((e) => log.warn("[주머니] 안 읽음 표시를 지우지 못했어요", e));
    }
    paintMsgBadges();
  }
  /** 처음 보는 캐릭터 이름만 GET 1번씩(이 창이 떠 있는 동안 기억). */
  async function msgNames(items) {
    const ids = [];
    for (const m of items) if (m.characterId && !msg.names.has(m.characterId) && !msg.nameReq.has(m.characterId) && !ids.includes(m.characterId)) ids.push(m.characterId);
    if (!ids.length) return;
    for (const id of ids.slice(0, CAP.wallets)) {
      msg.nameReq.add(id);
      try {
        const row = await api(`characters/${enc(id)}`);
        msg.names.set(id, cardOf(row).name || "캐릭터");
        // 콘보 전용 표시 이름: 캐릭터 data.extensions.convoDisplayName (엔진 ChatArea.tsx toCharacterMapValue)
        const c = parseRecord(row?.data), ext = parseRecord(c.extensions), inner = parseRecord(parseRecord(c.data).extensions);
        const dn = str(typeof ext.convoDisplayName === "string" ? ext.convoDisplayName : inner.convoDisplayName, 40);
        if (dn) msg.alias.set(id, dn);
      }
      catch { msg.names.set(id, "캐릭터"); }
    }
    msgPaint();
  }
  function msgThreadFor(chatId) {
    if (!msg.thread || msg.thread.chatId !== chatId) msg.thread = { chatId, items: [], hasMore: false, loading: false, older: false, error: "", loaded: false };
    return msg.thread;
  }
  /** 최근 메시지 30개(fresh) 또는 그보다 앞 30개(older)를 GET 1번. */
  async function msgLoadThread(chatId, mode = "fresh") {
    const t = msgThreadFor(chatId);
    if (mode === "older") {
      const oldest = t.items.find((m) => !m.local);
      if (t.older || !oldest) return;
      t.older = true;
    } else {
      if (t.loading) return;
      t.loading = true;
    }
    t.error = "";
    msgPaint();
    try {
      let q = `limit=${MSG_PAGE}`;
      if (mode === "older") { const o = t.items.find((m) => !m.local); q += `&before=${enc(`${o.createdAt}|${enc(o.id)}`)}`; }
      const list = arr(await api(`chats/${enc(chatId)}/messages?${q}`)).filter((m) => isRecord(m) && m.id != null).map(normMsg);
      if (msg.thread !== t) return;
      if (mode === "older") {
        const ids = new Set(t.items.map((m) => m.id));
        t.items = [...list.filter((m) => !ids.has(m.id)), ...t.items];
        t.hasMore = list.length >= MSG_PAGE;
        msg.anchor = "older";
      } else {
        const freshIds = new Set(list.map((m) => m.id));
        const firstT = list.length ? tms(list[0].createdAt) : Infinity;
        const keepOld = t.items.filter((m) => !m.local && !freshIds.has(m.id) && tms(m.createdAt) < firstT);
        const locals = t.items.filter((m) => m.local && (m.failed || m.sending));
        const before = t.items.filter((m) => !m.local).map((m) => m.id).join(",");
        t.items = [...keepOld, ...list, ...locals];
        t.hasMore = keepOld.length ? t.hasMore : list.length >= MSG_PAGE;
        if (!t.loaded || before !== t.items.filter((m) => !m.local).map((m) => m.id).join(",")) msg.anchor = "bottom";
        t.loaded = true;
      }
      void msgNames(t.items.filter((m) => m.role === "assistant"));
      if (mode === "fresh" && msgVisible() && msg.selId === chatId) msgViewed(chatId);
    } catch (e) {
      if (msg.thread === t) t.error = `메시지를 불러오지 못했어요: ${e.message || e}`;
    } finally {
      if (mode === "older") t.older = false; else t.loading = false;
      msgPaint();
    }
  }

  /** 엔진 클라이언트(api-client.ts streamEvents)와 같은 방식: 줄 단위로 나눠 `data:` 줄의 JSON만 읽는다. */
  async function readSse(res, onEvent) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handle = (lines) => {
      for (const line of lines) {
        const l = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!l.startsWith("data:")) continue;
        let d = l.slice(5);
        if (d.startsWith(" ")) d = d.slice(1);
        d = d.trimEnd();
        if (!d || d === "[DONE]") continue;
        let ev = null;
        try { ev = JSON.parse(d); } catch { continue; }
        if (isRecord(ev)) { try { onEvent(ev); } catch (e) { log.warn("[주머니] 메시지 이벤트 처리 실패", e); } }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buf += dec.decode(); handle(buf.split(/\r?\n/)); break; }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      handle(lines);
    }
  }
  const evNames = (ev) => arr(ev?.characters).map((x) => str(x, 40)).filter(Boolean).join(", ");
  function msgOnEvent(s, t, local, ev) {
    const type = String(ev.type || "");
    if (type === "message_saved") {
      if (!isRecord(ev.data)) return;
      const m = normMsg(ev.data);
      if (!m.id) return;
      // 콘보 다리: 보낸 문자 · 받은 답장을 그 RP 방에 바로 넣는다(호출 없음, 저장은 스트림이 끝날 때 한 번).
      if (s.rpId) bridgePush(s.rpId, s.chatId, ev.data);
      if (m.role === "user" && local.local) {
        Object.assign(local, m, { local: false, saved: true, sending: false, failed: false });
      } else {
        const i = t.items.findIndex((x) => x.id === m.id);
        if (i >= 0) t.items[i] = m; else t.items.push(m);
        if (m.role === "assistant") {
          void msgNames([m]);
          // 창을 닫았거나 다른 콘보를 보고 있으면 안 읽음으로 센다.
          if (!(msgVisible() && msg.selId === s.chatId)) { msg.unread.set(s.chatId, (msg.unread.get(s.chatId) || 0) + 1); paintMsgBadges(); }
        }
      }
      msg.anchor = "bottom";
    } else if (type === "typing") { s.phase = "typing"; s.who = evNames(ev); }
    else if (type === "delayed") { s.phase = "delayed"; s.who = evNames(ev); }
    else if (type === "offline") { const who = evNames(ev); msg.note = { chatId: s.chatId, text: `오프라인이에요${who ? ` (${who})` : ""}` }; }
    else if (type === "generation_discarded") msg.note = { chatId: s.chatId, text: "같은 말을 되풀이해서 이번 답장은 올리지 않았어요." };
    else if (type === "aborted") msg.note = { chatId: s.chatId, text: "답장을 멈췄어요." };
    else if (type === "error") msg.fail = { chatId: s.chatId, text: `답장을 만들지 못했어요: ${str(typeof ev.data === "string" ? ev.data : ev.data?.message, 300) || "알 수 없는 오류"}` };
    else if (type === "done") { s.done = true; s.phase = ""; }
    else return;
    msgPaint();
  }
  /** 보내기: POST /api/generate 1번(스트림). 서버가 내 메시지와 답장을 저장한다. 연결(connectionId)은 넘기지 않는다(콘보 방 설정 그대로). */
  async function msgSend(chatId, value, retry) {
    if (msg.send) return;
    const content = retry ? retry.text : String(value || "").trim().slice(0, MSG_MAX_LEN);
    if (!content) return;
    const t = msgThreadFor(chatId);
    let local = retry ? t.items.find((m) => m.id === retry.localId && m.local) : null;
    if (!local) {
      local = { id: `local-${uid()}`, local: true, role: "user", characterId: "", content, createdAt: new Date().toISOString(), hidden: false, attach: 0 };
      t.items.push(local);
    }
    local.sending = true; local.failed = false;
    const submissionId = retry?.submissionId || `jmn-${uid()}`;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const s = { chatId, rpId: msg.forRp, phase: "sending", who: "", done: false, stopped: false, ctrl, killTimer: null };
    msg.send = s; msg.fail = null; msg.note = null; msg.anchor = "bottom";
    msgPaint();
    let tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
    try {
      const res = await hostFetch("/api/generate", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({ chatId, userMessage: content, streaming: true, userStatus: "active", userTimeZone: tz.slice(0, 100), submissionId }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok || !res.body) {
        let detail = `요청 실패 (${res.status})`;
        try {
          const raw = await res.text();
          try { const j = JSON.parse(raw); if (isRecord(j) && (j.error || j.message)) detail = String(j.error || j.message); } catch { if (raw) detail = raw.slice(0, 200); }
        } catch {}
        const err = new Error(detail); err.status = res.status; throw err;
      }
      await readSse(res, (ev) => msgOnEvent(s, t, local, ev));
    } catch (e) {
      if (s.stopped || e?.name === "AbortError") { if (!msg.note) msg.note = { chatId, text: "답장을 멈췄어요." }; }
      else if (e?.status === 409) {
        if (local.local) local.failed = true;
        msg.fail = { chatId, text: "이 콘보 방에서 이미 답장을 만드는 중이에요.", retry: local.local ? { text: content, submissionId, localId: local.id } : null };
      } else {
        if (local.local) local.failed = true;
        msg.fail = { chatId, text: `보내지 못했어요: ${e?.message || e}` };
      }
    } finally {
      local.sending = false;
      if (s.killTimer != null) timers.clear(s.killTimer);
      if (msg.send === s) msg.send = null;
      // 콘보 다리: 받은 문자가 있으면 RP 숨김 메시지를 바로 맞춘다(다음 RP 답장 전에).
      const rpRoom = s.rpId ? state.rooms.get(s.rpId) : null;
      if (rpRoom) flushNow(rpRoom);
      if (msgVisible() && msg.selId === chatId) msgViewed(chatId);
      msgPaint();
    }
    // 멈췄거나 스트림이 끝 신호 없이 끊겼으면, 서버에 저장된 것과 맞추려고 한 번만 다시 읽는다.
    if ((s.stopped || !s.done) && !(msg.fail && msg.fail.chatId === chatId) && msg.thread === t) void msgLoadThread(chatId);
  }
  /** 멈추기: POST /api/generate/abort 1번. 5초 안에 스트림이 끝나지 않으면 이 창의 연결만 끊는다. */
  async function msgStop() {
    const s = msg.send;
    if (!s || s.stopped) return;
    s.stopped = true;
    msgPaint();
    try { await api("generate/abort", { method: "POST", body: { chatId: s.chatId } }); }
    catch (e) { log.warn("[주머니] 멈추지 못했어요", e); }
    if (msg.send === s) s.killTimer = timers.set(() => { if (msg.send === s) { try { s.ctrl?.abort(); } catch {} } }, 5000);
  }
  /** 연결하기: POST /api/chats/:콘보id/connect { targetChatId: RP방 id } (엔진 화면과 같은 방향 · 양쪽 연결). */
  async function msgConnect(rpId, convo) {
    if (msg.connectBusy) return;
    msg.connectBusy = true; setStatus(""); render();
    try {
      await api(`chats/${enc(convo.id)}/connect`, { method: "POST", body: { targetChatId: rpId } });
      convo.connectedChatId = rpId;
      const rp = msg.rpRows?.get(rpId);
      if (rp) rp.connectedChatId = convo.id;
      const room = state.rooms.get(rpId);
      if (room?.chat) { room.chat.connectedChatId = convo.id; markBridge(room); }
      msg.confirmConnect = false;
      setStatus(`‘${convo.name || "콘보 방"}’과 연결했어요. 이제 이 콘보가 답장할 때마다 이 RP의 최근 대화를 읽어요.`);
    } catch (e) { setStatus(`연결하지 못했어요: ${e.message || e}`); }
    finally { msg.connectBusy = false; render(); }
  }
  function msgPick(room, id) {
    msg.selId = id; msg.picking = false; msg.confirmConnect = false; msg.fail = null; msg.note = null;
    const picks = readMap(MSG_PICK_KEY);
    if (picks[room.id] !== id) { delete picks[room.id]; picks[room.id] = id; writeMap(MSG_PICK_KEY, picks, 100); markBridge(room); }
    if (msg.thread?.chatId !== id) msg.thread = null;
    msg.anchor = "bottom";
    setStatus(""); render();
    void msgLoadThread(id);
  }
  /** RP 방 기준으로 콘보 나누기: 연결된 콘보 → 같은 캐릭터가 있는 콘보 → 나머지(최근 순). */
  function msgGroups(room) {
    const rp = msg.rpRows?.get(room.id) || { connectedChatId: str(room.chat?.connectedChatId, 256), characterIds: chatCharacterIds(room.chat) };
    const all = [...(msg.convos || [])].sort((a, b) => tms(b.last) - tms(a.last));
    const connected = rp.connectedChatId ? all.find((c) => c.id === rp.connectedChatId) || null : null;
    const shared = all.filter((c) => c !== connected && c.characterIds.some((id) => rp.characterIds.includes(id)));
    const others = all.filter((c) => c !== connected && !shared.includes(c));
    return { rp, connected, shared, others };
  }
  /** 탭을 그릴 때 필요한 것만 부른다: 목록이 없거나 창을 다시 열었으면 목록 1번, 탭을 열 때 고른 콘보 1번. */
  function msgEnsure(room) {
    if (msg.forRp !== room.id) {
      msg.forRp = room.id; msg.selId = ""; msg.picking = false; msg.confirmConnect = false; msg.showOthers = false; msg.fresh = true;
    }
    if ((!msg.convos || msg.listStale) && !msg.listErr) {
      if (!msg.listPromise) void msgLoadList().then(() => render());
      if (!msg.convos) return;
    }
    if (msg.listPromise) return;
    if (!msg.selId && !msg.picking) {
      const g = msgGroups(room);
      const remembered = readMap(MSG_PICK_KEY)[room.id];
      const pick = (remembered && msgConvo(remembered)) || g.connected;
      if (pick) { msg.selId = pick.id; msg.fresh = true; } else msg.picking = true;
    }
    if (msg.selId && msg.fresh && msgConvo(msg.selId)) {
      msg.fresh = false;
      if (msg.thread?.chatId !== msg.selId) msg.thread = null;
      void msgLoadThread(msg.selId);
    }
  }

  // ── 엔진 알림 말풍선 지켜보기 (네트워크 없음, 바뀌었을 때만 목록 GET 1번 · 10초에 1번까지) ──
  let bubbleBox = null, sawPrimary = false, checkTimer = null, checkAt = 0, observer = null;
  const isBubbleBox = (n) => !!n && n.nodeType === 1 && !!n.classList && BUBBLE_CLASSES.every((c) => n.classList.contains(c));
  /** 예비 규칙(엔진 클래스가 바뀌어 위 묶음을 한 번도 못 찾았을 때만): 새로 붙은 작은 img가
   *  화면 오른쪽 끝에 붙은 좁은 absolute/fixed 기둥 안에 있으면 알림 말풍선으로 본다. 채팅 본문 아바타는 흐름 안이라 걸리지 않는다. */
  function fallbackBubble(n) {
    if (!n.childElementCount && n.tagName !== "IMG") return false;
    const img = n.tagName === "IMG" ? n : n.querySelector("img");
    if (!img || (root && root.contains(img))) return false;
    try {
      const ir = img.getBoundingClientRect();
      if (!(ir.width > 0 && ir.width <= 72)) return false;
      let el = img.parentElement;
      for (let i = 0; el && el !== document.body && i < 6; i++, el = el.parentElement) {
        const pos = getComputedStyle(el).position;
        if (pos !== "absolute" && pos !== "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width <= 120 && vw() - r.right <= 48) return true;
      }
    } catch {}
    return false;
  }
  function onMutations(list) {
    if (bubbleBox && !bubbleBox.isConnected) bubbleBox = null;
    let hit = false;
    for (const m of list) {
      const tg = m.target;
      if (!tg || (root && root.contains(tg))) continue;
      if (bubbleBox && bubbleBox.contains(tg)) { hit = true; break; }
      if (m.type !== "childList") continue;
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        let box = isBubbleBox(n) ? n : null;
        if (!box && n.childElementCount && (n.tagName === "MAIN" || n.getElementsByTagName("main").length)) box = n.querySelector(BUBBLE_SEL);
        if (box) { bubbleBox = box; sawPrimary = true; hit = true; break; }
        if (!sawPrimary && fallbackBubble(n)) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) msgBubbleSignal();
  }
  /** 말풍선 신호 → 10초에 1번까지 목록 GET 1번(묶인 신호는 끝에 한 번 더). */
  function msgBubbleSignal() {
    if (checkTimer != null) return;
    checkTimer = timers.set(() => { checkTimer = null; void msgCheck(); }, Math.max(0, checkAt + MSG_THROTTLE_MS - Date.now()));
  }
  async function msgCheck() {
    checkAt = Date.now();
    await msgLoadList();
    // 메신저가 그 콘보를 보고 있으면 최근 메시지 1번만 다시 읽는다.
    if (msgVisible() && msg.selId && !msg.send && !msg.picking) {
      const c = msgConvo(msg.selId);
      const t = msg.thread && msg.thread.chatId === msg.selId ? msg.thread : null;
      let newest = 0;
      for (const m of t ? t.items : []) if (!m.local) newest = Math.max(newest, tms(m.createdAt));
      if (c && (c.unreadServer > 0 || tms(c.last) > newest)) await msgLoadThread(msg.selId);
    }
  }
  function startBubbleWatch() {
    if (typeof MutationObserver === "undefined") return;
    try { const b = document.querySelector(BUBBLE_SEL); if (b) { bubbleBox = b; sawPrimary = true; msgBubbleSignal(); } } catch {}
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    onCleanup(() => { observer?.disconnect(); observer = null; if (checkTimer != null) timers.clear(checkTimer); checkTimer = null; });
  }

  // ── 메시지 탭 그리기 ──
  /** 탭 숫자 · 버튼 점만 고친다(입력 중인 칸 보호). */
  function paintMsgBadges() {
    updateFab();
    if (!panel || !state.open) return;
    const t = panel.querySelector(".jmn-tabs");
    if (t) { const left = Number(t.scrollLeft) || 0; const nt = tabs(); t.replaceWith(nt); if (left) nt.scrollLeft = left; runPaint(); }
    for (const el of panel.querySelectorAll("[data-unread-for]")) {
      const n = msg.unread.get(el.getAttribute("data-unread-for")) || 0;
      el.textContent = n > 99 ? "99+" : String(n);
      el.hidden = !n;
    }
  }
  const unreadBadge = (id) => { const n = msg.unread.get(id) || 0; return h("span", { class: "jmn-tab-badge", "data-unread-for": id, hidden: !n, text: n > 99 ? "99+" : String(n) }); };
  function threadInfo(el) {
    return el ? { chatId: el.getAttribute("data-chat"), top: el.scrollTop, fromBottom: el.scrollHeight - el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 24 } : null;
  }
  function placeThread(el, info) {
    const a = msg.anchor;
    msg.anchor = null;
    const same = !!info && info.chatId === el.getAttribute("data-chat");
    if (a === "older" && same) el.scrollTop = Math.max(0, el.scrollHeight - info.fromBottom);
    else if (a === "bottom" || !same || info.atBottom) el.scrollTop = el.scrollHeight;
    else el.scrollTop = info.top;
  }
  /** 대화창 · 상태 줄 · 보내기 버튼만 바꾼다(입력칸은 그대로). 그 밖의 경우는 화면을 다시 그린다. */
  function msgPaint() {
    if (!msgVisible()) return;
    const oldT = panel.querySelector(".jmn-msg-thread");
    const cur = msgConvo(msg.selId);
    if (!oldT || !cur || msg.picking || oldT.getAttribute("data-chat") !== cur.id) { softRender(); return; }
    const info = threadInfo(oldT);
    const nt = msgThreadEl(cur);
    oldT.replaceWith(nt);
    placeThread(nt, info);
    const oldS = panel.querySelector(".jmn-msg-state");
    if (oldS) oldS.replaceWith(msgStateEl(cur));
    const b = panel.querySelector(".jmn-msg-send");
    if (b) b.disabled = !!msg.send;
  }
  function msgItem(room, c, label) {
    return h("button", { class: "jmn-msg-item", type: "button", "data-nav": "1", "aria-current": String(c.id === msg.selId), onclick: () => msgPick(room, c.id) },
      h("span", { class: "jmn-row-main" }, h("span", { class: "jmn-row-title", text: c.name || "이름 없는 콘보" }), c.last ? h("small", { text: `마지막 메시지 ${fmtTime(c.last)}` }) : null),
      label ? chip(label) : null,
      unreadBadge(c.id));
  }
  function msgPicker(room, g) {
    const box = h("div", { class: "jmn-msg-list" });
    box.append(h("div", { class: "jmn-sec" }, h("b", { text: "콘보 방 고르기" }), h("span", { text: `${(msg.convos || []).length}곳` }),
      btn(msg.listBusy ? "불러오는 중…" : "목록 새로고침", () => { void msgLoadList().then(() => render()); render(); }, { ghost: true, nav: true, disabled: msg.listBusy }),
      msg.selId && msgConvo(msg.selId) ? btn("닫기", () => { msg.picking = false; render(); }, { ghost: true, nav: true }) : null));
    if (!(msg.convos || []).length) { box.append(empty("콘보 방이 없어요. 엔진에서 콘보(Conversation) 방을 먼저 만들어 주세요.")); return box; }
    if (g.connected) box.append(msgItem(room, g.connected, "연결된 콘보"));
    if (g.shared.length) { box.append(hint("같은 캐릭터가 있는 콘보")); for (const c of g.shared) box.append(msgItem(room, c, "")); }
    if (!g.connected && !g.shared.length) box.append(hint("이 RP 방과 연결되거나 같은 캐릭터가 있는 콘보가 없어요."));
    if (g.others.length) {
      box.append(btn(`${msg.showOthers ? "▾" : "▸"} 다른 콘보 방 (${g.others.length})`, () => { msg.showOthers = !msg.showOthers; render(); }, { ghost: true, nav: true }));
      if (msg.showOthers) for (const c of g.others) box.append(msgItem(room, c, ""));
    }
    return box;
  }
  function msgConnectBox(room, g, cur) {
    if (g.rp.connectedChatId) return g.connected ? null : hint("이 RP 방은 다른 방과 연결돼 있어요. 연결은 엔진의 채팅 설정 → 연결된 채팅에서 바꿀 수 있어요.");
    if (cur.connectedChatId && cur.connectedChatId !== room.id) return hint("이 콘보는 다른 RP · 게임 방과 연결돼 있어요. 연결은 엔진의 채팅 설정 → 연결된 채팅에서 바꿀 수 있어요.");
    if (!msg.confirmConnect) {
      return h("div", { class: "jmn-actions" },
        btn("이 RP 방과 연결하기", () => { msg.confirmConnect = true; setStatus(""); render(); }, { ghost: true, disabled: msg.connectBusy }),
        h("span", { class: "jmn-hint", text: "아직 이 RP 방과 연결된 콘보가 없어요." }));
    }
    return h("div", { class: "jmn-form" },
      h("b", { text: `‘${cur.name || "콘보 방"}’을 이 RP 방과 연결할까요?` }),
      hint("연결하면 콘보가 이 RP의 최근 대화 20개를 읽어요. 콘보가 답장할 때마다 읽고, RP는 콘보를 읽지 않아요."),
      hint("엔진의 ‘연결된 채팅’ 기능이에요. 채팅 설정 → 연결된 채팅에서 끊을 수 있어요."),
      h("div", { class: "jmn-actions" },
        btn(msg.connectBusy ? "연결하는 중…" : "연결하기", () => void msgConnect(room.id, cur), { disabled: msg.connectBusy }),
        btn("취소", () => { msg.confirmConnect = false; render(); }, { ghost: true })));
  }
  function msgThreadEl(cur) {
    const el = h("div", { class: "jmn-msg-thread", role: "log", "aria-live": "polite", "aria-label": `${cur.name || "콘보"} 메시지`, "data-chat": cur.id });
    const t = msg.thread && msg.thread.chatId === cur.id ? msg.thread : null;
    if (!t || (!t.loaded && !t.items.length)) { el.append(empty(t && t.error ? "" : "메시지를 불러오는 중이에요…")); if (t?.error) el.append(h("p", { class: "jmn-error", text: t.error })); return el; }
    if (t.hasMore) el.append(btn(t.older ? "불러오는 중…" : "이전 메시지 더 보기", () => void msgLoadThread(cur.id, "older"), { ghost: true, nav: true, disabled: t.older }));
    const shown = t.items.filter(shownMsg);
    if (!shown.length) el.append(empty("아직 메시지가 없어요. 첫 메시지를 보내 보세요."));
    const rowKey = `msg:${cur.id}`;
    freshRows(rowKey, shown.map((m) => m.id));
    let prevKey = "";
    for (const m of shown) {
      const me = m.role === "user";
      // 화자 묶음마다 한 줄(이름표 + 줄마다 말풍선). 캐릭터 글은 엔진 콘보 화면과 같은 규칙으로 나눈다.
      let groups;
      if (m.role === "assistant") {
        const known = convoKnown(cur.characterIds, m.characterId);
        const nm = msg.names.get(m.characterId);
        groups = convoGroups(m.content, { name: nm && nm !== "캐릭터" ? nm : "", display: msg.alias.get(m.characterId) || "" }, known);
      } else groups = [{ speaker: me ? "" : "내레이션", lines: nonBlank(m.content), own: true }];
      if (!groups.length || !groups.some((g) => g.lines.length)) groups = [{ speaker: groups[0]?.speaker ?? "", lines: [m.attach ? "(첨부)" : ""], own: true }];
      const time = m.failed ? "보내지 못했어요" : m.sending && m.local ? "보내는 중…" : fmtTime(m.createdAt);
      groups.forEach((g, gi) => {
        const narr = !me && !g.speaker && !g.own;
        const name = me ? "" : g.speaker || "캐릭터";
        const key = me ? "me" : narr ? "" : m.role === "narrator" ? "narrator" : `s:${normMatch(name)}`;
        const tail = gi === groups.length - 1 ? h("span", { class: "jmn-bub-time", text: time }) : null;
        el.append(rowIn(h("div", { class: `jmn-bub-row ${me ? "jmn-me" : "jmn-them"}${narr ? " jmn-narr" : ""}`, "data-failed": m.failed ? "1" : null, "data-pending": m.sending ? "1" : null },
          !me && !narr && key !== prevKey ? h("span", { class: "jmn-bub-name", text: name }) : null,
          ...g.lines.map((l) => h(narr ? "p" : "div", { class: narr ? "jmn-bub-narr" : "jmn-bub", text: l })),
          tail), rowKey, m.id));
        prevKey = key;
      });
    }
    // 답장을 기다리는 동안: 세 점이 통통 튄다(글로 된 상태는 아래 상태 줄이 알려 준다).
    const s = msg.send && msg.send.chatId === cur.id ? msg.send : null;
    if (s && !s.stopped && !s.done) el.append(h("div", { class: "jmn-typing", "aria-hidden": "true" }, h("i"), h("i"), h("i")));
    if (t.error) el.append(h("p", { class: "jmn-error", text: t.error }));
    return el;
  }
  function msgStateEl(cur) {
    const el = h("div", { class: "jmn-msg-state", role: "status" });
    const s = msg.send && msg.send.chatId === cur.id ? msg.send : null;
    if (s) {
      const who = s.who ? ` (${s.who})` : "";
      el.append(h("span", { text: s.stopped ? "멈추는 중…" : s.phase === "typing" ? `${s.who || "상대"} 입력 중…` : s.phase === "delayed" ? `바빠서 조금 늦게 답할 수 있어요${who}` : "보내는 중…" }),
        btn("멈추기", () => void msgStop(), { ghost: true, danger: true, disabled: s.stopped }));
    } else if (msg.send) el.append(h("span", { text: "다른 콘보 방에 보내는 중이에요. 끝나면 보낼 수 있어요." }));
    if (msg.note && msg.note.chatId === cur.id) el.append(h("span", { class: "jmn-msg-note", text: msg.note.text }));
    const f = msg.fail && msg.fail.chatId === cur.id ? msg.fail : null;
    if (f) {
      el.append(h("p", { class: "jmn-error", role: "alert", text: f.text }),
        f.retry ? btn("다시 보내기", () => void msgSend(cur.id, null, f.retry), { disabled: !!msg.send }) : null,
        btn("닫기", () => {
          const t = msg.thread;
          if (t && f.retry) t.items = t.items.filter((m) => m.id !== f.retry.localId);
          msg.fail = null; msgPaint();
        }, { ghost: true }));
    }
    return el;
  }
  function msgComposer(cur) {
    const doSend = () => {
      const area = panel.querySelector(".jmn-msg-ta");
      const v = area ? area.value : String(dget("m.text"));
      if (!v.trim() || msg.send) return;
      if (area) area.value = "";
      delete draft["m.text"];
      void msgSend(cur.id, v);
      area?.focus();
    };
    const area = h("textarea", { class: "jmn-in jmn-ta jmn-msg-ta", rows: "2", maxlength: String(MSG_MAX_LEN), placeholder: "메시지 (Enter 보내기 · Shift+Enter 줄바꿈)", "aria-label": `${cur.name || "콘보"}에 보낼 메시지`, value: dget("m.text", ""),
      oninput: (e) => { draft["m.text"] = e.target.value; },
      onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doSend(); } } });
    return h("form", { class: "jmn-msg-compose", onsubmit: (e) => { e.preventDefault(); doSend(); } },
      area,
      h("button", { class: "jmn-btn jmn-msg-send", type: "submit", text: "보내기", disabled: !!msg.send }));
  }
  function msgTab(room) {
    msgEnsure(room);
    const box = h("div", { class: "jmn-body jmn-msg" });
    if (!room.data) box.append(h("div", { class: "jmn-actions" }, btn("← 주머니 만들기", () => { state.tab = "wallet"; setStatus(""); render(); }, { ghost: true, nav: true })),
      hint("이 RP 방은 주머니가 없어서 콘보 대화를 RP에 전달하지 않아요. 주머니를 만들면 전달돼요."));
    if (msg.listErr) {
      box.append(h("p", { class: "jmn-error", text: msg.listErr }),
        h("div", { class: "jmn-actions" }, btn("다시 불러오기", () => { msg.listErr = ""; msg.fresh = true; render(); }, { ghost: true })));
      return box;
    }
    if (!msg.convos) { box.append(empty("콘보 방 목록을 불러오는 중이에요…")); return box; }
    const g = msgGroups(room);
    const cur = msgConvo(msg.selId);
    if (!cur || msg.picking) { box.append(msgPicker(room, g), hint(MSG_NOTE)); return box; }
    box.append(h("div", { class: "jmn-msg-head" },
      h("b", { text: cur.name || "이름 없는 콘보" }),
      g.connected === cur ? chip("연결된 콘보") : null,
      btn("새로고침", () => void msgLoadThread(cur.id), { ghost: true, nav: true, disabled: !!msg.thread?.loading }),
      btn("다른 콘보", () => { msg.picking = true; msg.confirmConnect = false; render(); }, { ghost: true, nav: true })));
    const conn = msgConnectBox(room, g, cur);
    if (conn) box.append(conn);
    box.append(msgThreadEl(cur), msgStateEl(cur), msgComposer(cur), hint(MSG_NOTE));
    return box;
  }

  // ── 렌더링 ──
  const viewRoom = () => state.rooms.get(state.viewId) || null;
  // 알림 줄: 먹색 막대가 아래에서 올라오고, 가는 줄이 줄어들다 다 줄면 저절로 닫힌다(글이 길면 조금 더 오래).
  const toastMs = (t) => Math.min(7000, Math.max(2600, String(t).length * 70));
  let statusTimer = null;
  function setStatus(msg) {
    const t = msg || "";
    unlater(statusTimer); statusTimer = null;
    state.status = t; state.statusAt = Date.now();
    if (!t) return;
    statusTimer = later(() => {
      statusTimer = null;
      if (state.status !== t) return;
      state.status = "";
      panel?.querySelector(".jmn-status")?.remove();
    }, toastMs(t));
  }
  function statusEl() {
    const line = h("span", { class: "jmn-toastline", "aria-hidden": "true" });
    if (line.style) line.style.animationDuration = `${toastMs(state.status)}ms`;
    const p = h("p", { class: "jmn-status", role: "status", text: state.status }, lag(line, state.statusAt));
    return lag(p, state.statusAt);
  }
  function edit(room, fn, msg) { if (!room.data) return; fn(room.data); setStatus(msg || ""); markPending(room); scheduleSave(room); render(); }
  /** 입력 칸의 포커스를 잃지 않도록 다시 그리지 않는 고침. */
  function quietEdit(room, fn) { if (!room.data) return; fn(room.data); scheduleSave(room); }
  function fail(msg) { setStatus(msg); render(); }
  function isTyping() {
    const a = document.activeElement;
    return !!(panel && a && panel.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function softRender() { if (!isTyping()) render(); }

  let lastScrollKey = "";
  function render() {
    if (!panel) return;
    stopCount();
    paintQ = [];
    panel.hidden = !state.open;
    if (!state.open) { counter.last.clear(); tabIdxShown = null; return; }
    counter.seen = false;
    const room = viewRoom();
    const scrollKey = `${state.viewId}|${state.tab}|${state.shopId}`;
    const oldScroll = panel.querySelector(".jmn-scroll");
    const keepTop = oldScroll && scrollKey === lastScrollKey ? oldScroll.scrollTop : 0;
    const oldTabs = panel.querySelector(".jmn-tabs");
    const tabsLeft = oldTabs ? Number(oldTabs.scrollLeft) || 0 : 0;
    lastScrollKey = scrollKey;
    const kids = [header(room)];
    if (state.menuOpen) kids.push(roomMenu());
    const scroll = h("div", { class: "jmn-scroll" });
    if (state.busy === "room") scroll.append(empty("방을 불러오는 중이에요…"));
    else if (!room) scroll.append(empty(state.viewId ? "방을 불러오지 못했어요. 위의 방 이름(▾)을 눌러 다시 골라 주세요." : "RP 방에 들어가거나 위의 ‘방 고르기 ▾’에서 방을 골라 주세요."));
    else if (!isRp(room.chat)) scroll.append(empty("이 방은 RP 방이 아니라서 주머니를 쓸 수 없어요. 위의 방 이름(▾)을 눌러 RP 방을 골라 주세요."));
    else {
      const readOnly = room.id !== state.activeId;
      const setupOn = state.setup && state.setup.roomId === room.id;
      // 비밀 탭은 페르소나 단위, 메시지 탭은 콘보 방 단위라 월드 팩이 없는 방 · 보기 전용 방에서도 쓸 수 있다.
      const secretOn = (state.tab === "secret" || state.tab === "msg") && !setupOn;
      const msgOn = secretOn && state.tab === "msg";
      if (readOnly) scroll.append(h("p", { class: "jmn-note", text: msgOn ? "지금 들어가 있는 방이 아니에요. 메시지는 콘보 방으로 가서 여기서도 쓸 수 있어요." : secretOn ?"지금 들어가 있는 방이 아니에요. 비밀은 방이 아니라 페르소나에 딸려 있어서 여기서도 고칠 수 있어요." : "지금 들어가 있는 방이 아니라서 보기만 할 수 있어요. 고치려면 그 방에 들어가서 열어 주세요." }));
      if (room.ownerNote && !secretOn) scroll.append(h("p", { class: "jmn-note", text: "다른 방에서 복사된 주머니 데이터가 있어서, 이 방은 새로 시작해요." }));
      if (secretOn) {
        if (room.data) kids.push(tabs());
        scroll.append(msgOn ? msgTab(room) : secretTab(room));
      } else if (!room.data || setupOn) {
        if (readOnly && !room.data) scroll.append(empty("이 방은 아직 주머니를 만들지 않았어요."), secretLink());
        else scroll.append(setupView(room));
      } else {
        kids.push(tabs());
        scroll.append(body(room));
      }
      if (readOnly && !secretOn) for (const el of scroll.querySelectorAll("button:not([data-nav]), input, select, textarea")) el.disabled = true;
    }
    kids.push(scroll);
    if (state.status) kids.push(statusEl());
    const tInfo = threadInfo(panel.querySelector(".jmn-msg-thread"));
    panel.replaceChildren(...kids);
    if (keepTop) scroll.scrollTop = keepTop;
    const nt = panel.querySelector(".jmn-msg-thread");
    if (nt) placeThread(nt, tInfo);
    const newTabs = panel.querySelector(".jmn-tabs");
    if (newTabs && tabsLeft) newTabs.scrollLeft = tabsLeft;
    if (!counter.seen) counter.last.clear();
    runPaint();
    startCount();
  }
  // ── 잔고 숫자 굴리기: 보고 있는 동안 잔고가 바뀌면 옛 값에서 새 값까지 700ms ──
  const counter = { last: new Map(), run: [], raf: 0, seen: false };
  function countNum(key, to) {
    counter.seen = true;
    const el = h("b", { class: "jmn-bal-num", text: fmt(to) });
    // 글자 수(최종 값 기준)로 크기를 정해요. 긴 숫자만 작아지고, 굴러가는 동안 크기가 흔들리지 않아요.
    try { el.style.setProperty("--jm-n", String(Math.max(4, fmt(to).length))); } catch {}
    const from = counter.last.get(key);
    counter.last.set(key, to);
    if (from != null && from !== to && typeof window.requestAnimationFrame === "function" && !calm()) {
      el.textContent = fmt(from);
      counter.run.push({ el, key, from, to, cur: from });
    }
    return el;
  }
  /** 다시 그리거나 닫을 때 멈춘다. 굴러가던 숫자는 다음 그림에서 보이던 값부터 이어 간다. */
  function stopCount() {
    if (counter.raf) { try { window.cancelAnimationFrame(counter.raf); } catch {} counter.raf = 0; }
    for (const r of counter.run) counter.last.set(r.key, r.cur);
    counter.run = [];
  }
  function startCount() {
    if (!counter.run.length) return;
    const run = counter.run;
    let t0 = null;
    const step = (now) => {
      if (t0 == null) t0 = now;
      const p = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - p, 3);
      for (const r of run) { r.cur = Math.round(r.from + (r.to - r.from) * e); r.el.textContent = fmt(r.cur); }
      if (p < 1) counter.raf = window.requestAnimationFrame(step);
      else { counter.raf = 0; if (counter.run === run) counter.run = []; }
    };
    counter.raf = window.requestAnimationFrame(step);
  }
  onCleanup(stopCount);
  const empty = (t) => h("p", { class: "jmn-empty", text: t });
  const hint = (t) => h("p", { class: "jmn-hint", text: t });
  function btn(label, onclick, opts = {}) {
    return h("button", { class: `jmn-btn${opts.ghost ? " jmn-ghost" : ""}${opts.danger ? " jmn-danger" : ""}${opts.cls ? ` ${opts.cls}` : ""}`, type: opts.submit ? "submit" : "button", text: label, disabled: !!opts.disabled, "data-nav": opts.nav ? "1" : null, "aria-pressed": opts.pressed == null ? null : String(!!opts.pressed), "aria-label": opts.label || null, onclick });
  }
  function row(title, sub, ...right) { return rowTag(title, null, sub, ...right); }
  /** 제목 옆에 작은 표(NEW 등)를 붙인 줄. */
  function rowTag(title, tag, sub, ...right) {
    const main = h("div", { class: "jmn-row-main" }, h("span", { class: "jmn-row-title", text: title }), tag);
    if (sub) main.append(h("small", { text: sub }));
    return h("div", { class: "jmn-row" }, main, h("div", { class: "jmn-row-right" }, right));
  }
  /** 알약 모양 고르기(검은 알약이 미끄러져 간다). key는 이전 자리를 기억하는 이름. */
  const segSeen = new Map();
  function segPill(key, labels, idx, onPick, opts = {}) {
    const n = labels.length;
    const pill = h("b", { "aria-hidden": "true" });
    if (pill.style) pill.style.width = `calc((100% - 6px) / ${n})`;
    const prev = segSeen.get(key);
    segSeen.set(key, idx);
    slideFrom(pill, "transform", prev == null ? null : `translateX(${prev * 100}%)`, `translateX(${idx * 100}%)`);
    const box = h("div", { class: "jmn-segp", role: "group", "aria-label": opts.label || null }, pill,
      labels.map((l, i) => h("button", { type: "button", class: i === idx ? "jmn-on" : null, "aria-pressed": String(i === idx), "data-nav": opts.nav ? "1" : null, disabled: !!opts.disabled, text: l, onclick: () => { if (i !== idx) onPick(i); } })));
    if (box.style) box.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    return box;
  }
  /** 켜고 끄는 스위치(role="switch"). 바뀐 직후면 손잡이가 옛 자리에서 미끄러져 간다. */
  const swSeen = new Map();
  function switchEl(key, label, on, onFlip, opts = {}) {
    const prev = swSeen.get(key);
    swSeen.set(key, on);
    const cls = (v) => `jmn-sw${v ? " jmn-on" : ""}`;
    const b = h("button", { class: cls(on), type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, disabled: !!opts.disabled, onclick: onFlip }, h("i", { "aria-hidden": "true" }));
    if (prev != null && prev !== on && !calm()) { b.className = cls(prev); afterPaint(() => { void b.offsetWidth; b.className = cls(on); }); }
    return b;
  }
  /** 바꾼 직후 잠깐 보이는 ‘저장됨 ✓’. */
  function savedEl(key) {
    const t = fxAt.get(`saved:${key}`);
    if (t == null || Date.now() - t >= 1800) return null;
    return lag(h("span", { class: "jmn-saved", "data-saved": key, text: "저장됨 ✓" }), t);
  }
  function markSaved(key) {
    fxMark(`saved:${key}`);
    later(() => { for (const el of panel?.querySelectorAll(`[data-saved="${key}"]`) || []) el.remove(); }, 1850);
  }
  /** 스위치 한 줄: 이름 · 설명 · 저장됨 · 스위치. */
  function switchRow(key, title, help, on, onFlip) {
    return h("div", { class: "jmn-swrow" },
      h("div", { class: "jmn-row-main" }, h("span", { class: "jmn-row-title", text: title }), help ? h("small", { text: help }) : null),
      savedEl(key),
      switchEl(key, title, on, onFlip));
  }
  const numEl = (t, cls) => h("span", { class: `jmn-num${cls ? ` ${cls}` : ""}`, text: t });
  const chip = (t, go) => h("span", { class: `jmn-chip${go ? " jmn-chip-go" : ""}`, text: t });
  function section(title, sub) { return h("div", { class: "jmn-sec" }, h("b", { text: title }), sub ? h("span", { text: sub }) : null); }
  function inp(key, props = {}) {
    const { def = "", ...rest } = props;
    return h("input", { class: "jmn-in", type: "text", autocomplete: "off", ...rest, value: dget(key, def), oninput: (e) => { draft[key] = e.target.value; } });
  }
  function sel(key, options, def) {
    const s = h("select", { class: "jmn-in", onchange: (e) => { draft[key] = e.target.value; } }, options.map(([v, l]) => h("option", { value: v, text: l })));
    const want = dget(key, def);
    s.value = options.some(([v]) => v === want) ? want : (options[0]?.[0] ?? "");
    return s;
  }
  function field(label, control) { return h("label", { class: "jmn-field" }, h("span", { text: label }), control); }
  const aiUse = () => h("p", { class: "jmn-hint", "data-ai-use": "1", text: aiUseText() });
  /** ‘AI 연결’ 고르기. compact는 처음 만들기 화면용(목록은 버튼을 눌러야 불러온다). */
  function aiPicker(compact) {
    const list = ai.list || [];
    const cur = ai.pref.connectionId;
    const missing = !!cur && !list.some((c) => c.id === cur);
    const options = [["", "방에 연결된 모델 사용 (기본)"], ...list.map((c) => [c.id, c.label])];
    if (missing) options.push([cur, `${ai.pref.label || "고른 연결"}${ai.list ? " (목록에 없음)" : ""}`]);
    const s = h("select", { class: "jmn-in", onchange: (e) => {
      const id = e.target.value;
      const label = list.find((c) => c.id === id)?.label || (id === cur ? ai.pref.label : "");
      saveAiPref(id, label);
      for (const el of panel.querySelectorAll("[data-ai-use]")) el.textContent = aiUseText();
    } }, options.map(([v, l]) => h("option", { value: v, text: l })));
    s.value = cur;
    return h("div", { class: "jmn-form jmn-ai", "data-compact": compact ? "1" : null },
      h("div", { class: "jmn-ai-row" },
        field("AI 연결", s),
        btn(ai.busy ? "불러오는 중…" : ai.list ? "목록 새로고침" : "목록 불러오기", () => { void loadConns(); refreshAiPickers(); }, { ghost: true, disabled: ai.busy })),
      hint(compact ? "세계관 읽기 · 새 퀘스트 받기 · 다 팔린 물건 채우기 · 월급 추측하기에만 쓰여요. 모든 방에 똑같이 적용돼요." : "세계관 읽기 · 새 퀘스트 받기 · 다 팔린 물건 채우기 · 월급 추측하기에만 쓰여요. RP 답장은 방의 모델이 그대로 써요."),
      compact ? null : hint("이 브라우저에 저장되고 모든 방에 똑같이 적용돼요."),
      ai.error ? h("p", { class: "jmn-error", text: ai.error }) : null,
      ai.list && missing ? h("p", { class: "jmn-note", text: "고른 연결이 목록에 없어요. 다시 골라 주세요." }) : null);
  }
  /** 화면 전체를 다시 그리지 않고(입력 중인 칸 보호) AI 연결 칸만 바꾼다. */
  function refreshAiPickers() {
    if (!panel) return;
    for (const el of panel.querySelectorAll(".jmn-ai")) {
      const off = !!el.querySelector("select")?.disabled;
      const hadFocus = el.contains(document.activeElement);
      const next = aiPicker(el.getAttribute("data-compact") === "1");
      if (off) for (const c of next.querySelectorAll("button, select")) c.disabled = true;
      el.replaceWith(next);
      if (hadFocus) next.querySelector("select:not(:disabled)")?.focus();
    }
    for (const el of panel.querySelectorAll("[data-ai-use]")) el.textContent = aiUseText();
  }

  function header(room) {
    const isActive = room && room.id === state.activeId;
    const label = room ? `${str(room.chat?.name, 60) || "이름 없는 방"}${isActive ? " · 지금 방" : " · 보기 전용"}` : "방 고르기";
    // 둥근 단말기 배지 · 명조 제목 · 방 이름 칩(누르면 RP 방 고르기) · 닫기
    return h("div", { class: "jmn-head" },
      h("span", { class: "jmn-badge", "aria-hidden": "true" }),
      h("div", { class: "jmn-titles" },
        h("strong", { class: "jmn-title", text: "주머니" }),
        h("button", { class: "jmn-roomchip", type: "button", "aria-label": `RP 방 고르기 (지금 보는 방: ${label})`, "aria-haspopup": "menu", "aria-expanded": String(state.menuOpen), onclick: toggleMenu },
          h("span", { class: "jmn-room", text: label }), h("span", { class: "jmn-caret", "aria-hidden": "true", text: "▾" }))),
      h("button", { class: "jmn-icon", type: "button", "aria-label": "주머니 닫기", text: "✕", onclick: () => setOpen(false) }));
  }
  function roomMenu() {
    const box = h("div", { class: "jmn-menu", role: "menu" }, h("div", { class: "jmn-cap", text: "RP 방" }));
    if (!state.chatList) box.append(h("div", { class: "jmn-cap", text: state.busy === "list" ? "불러오는 중이에요…" : "목록을 불러오지 못했어요." }));
    else if (!state.chatList.length) box.append(h("div", { class: "jmn-cap", text: "RP 방이 없어요." }));
    else for (const c of state.chatList) {
      box.append(h("button", { type: "button", role: "menuitem", "aria-current": String(c.id === state.viewId), onclick: () => selectRoom(c.id) },
        h("span", { class: "jmn-name", text: str(c.name, 60) || "이름 없는 방" }),
        c.id === state.activeId ? h("span", { class: "jmn-here", text: "지금 방" }) : null));
    }
    return box;
  }
  // 탭 밑줄: 탭 수만큼 나눈 폭, 고른 탭 자리로 350ms 미끄러진다. 탭 수가 바뀌어도 그때그때 센다.
  let tabIdxShown = null;
  function tabs() {
    const n = msgTotal();
    const list = TABS;
    const idx = Math.max(0, list.findIndex(([id]) => id === state.tab));
    const bar = h("span", { class: "jmn-tab-bar", "aria-hidden": "true" });
    if (bar.style) bar.style.width = `${100 / list.length}%`;
    slideFrom(bar, "transform", tabIdxShown == null ? null : `translateX(${tabIdxShown * 100}%)`, `translateX(${idx * 100}%)`);
    tabIdxShown = idx;
    const track = h("div", { class: "jmn-tabs-in", role: "tablist" }, list.map(([id, label]) =>
      h("button", { type: "button", role: "tab", "data-nav": "1", "data-tab": id, "aria-selected": String(state.tab === id), "aria-label": id === "msg" && n ? `${label} (새 메시지 ${n}개)` : null, onclick: () => openTab(id) },
        label, id === "msg" && n ? h("span", { class: "jmn-tab-badge", "aria-hidden": "true", text: n > 99 ? "99+" : String(n) }) : null)), bar);
    const box = h("div", { class: "jmn-tabs" }, track);
    // 좁은 화면에서 고른 탭이 가려져 있으면 그 탭까지 옆으로 민다(탭 줄 안에서만).
    afterPaint(() => {
      const b = box.querySelector?.(`[data-tab="${state.tab}"]`);
      if (!b || !(box.clientWidth > 0)) return;
      const left = b.offsetLeft, right = left + b.offsetWidth;
      if (left < box.scrollLeft) box.scrollLeft = left;
      else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
    });
    return box;
  }
  function openTab(id) {
    if (id === "msg" && state.tab !== "msg") { msg.fresh = true; msg.confirmConnect = false; }
    // 상점의 ‘NEW’ 표시는 상점 탭을 떠나면 지운다. 가방의 ‘도착’ 카드는 가방 탭을 떠나면 지운다.
    if (state.tab === "shop" && id !== "shop") newItems.clear();
    if (state.tab === "bag" && id !== "bag") arrived.clear();
    state.tab = id; state.wact = null; state.buy = null; state.questForm = false; state.confirm = null; sec.form = null; sec.confirmDel = ""; setStatus(""); render();
  }
  function body(room) {
    trackDeliveries(room);
    if (state.tab === "shop") return shopTab(room);
    if (state.tab === "bag") return bagTab(room);
    if (state.tab === "quest") return questTab(room);
    if (state.tab === "set") return settingsTab(room);
    return walletTab(room);
  }

  // ── 처음 만들기 ──
  function setupView(room) {
    const box = h("div", { class: "jmn-body" });
    const s = state.setup && state.setup.roomId === room.id ? state.setup : null;
    const cancel = () => { state.setup = null; setStatus(""); render(); };
    if (!s) {
      box.append(
        h("p", { class: "jmn-lead", text: "이 방은 아직 주머니가 없어요." }),
        hint("‘세계관 읽기’를 누르면 이 방에 켜진 로어북, 캐릭터 카드, 내 페르소나를 읽고 AI가 화폐 · 가게 · 임무 · 시작 잔고 초안을 한 번에 만들어요. 부르기 전에 예상 토큰을 먼저 보여 드려요."),
        h("div", { class: "jmn-actions" },
          btn("세계관 읽기", () => startGather(room, { rerun: false, reset: false }), { disabled: !!state.busy }),
          btn(state.busy === "setup" ? "만드는 중…" : "빈 틀로 시작", () => startEmpty(room), { ghost: true, disabled: !!state.busy })),
        hint("‘빈 틀로 시작’은 AI를 부르지 않아요. 화폐는 ‘골드’, 잔고는 0으로 시작하고 설정 탭에서 직접 채워요."),
        aiPicker(true),
        secretLink());
      return box;
    }
    if (s.phase === "gathering") box.append(empty("로어북과 캐릭터 카드를 읽는 중이에요…"));
    else if (s.phase === "confirm") {
      box.append(
        h("p", { class: "jmn-lead", text: `예상 입력 토큰: 약 ${fmt(s.tokens)}` }),
        hint(`로어북 ${s.books}권에서 켜진 항목 ${s.loreTotal}개 중 ${s.loreUsed}개를 담았어요(상시 항목 먼저, 약 ${fmt(SETUP_TOKEN_CAP)} 토큰까지). 답은 최대 4,000 토큰이에요. AI를 한 번 불러요.`),
        aiUse(),
        s.rerun ? hint(s.reset ? "지갑 · 가방 · 내역 · 임무를 모두 새로 만들어요." : "화폐 · 가게 · 새 임무만 바꾸고 지갑 · 가방 · 내역 · 진행 중인 임무는 그대로 둬요.") : "",
        h("div", { class: "jmn-actions" }, btn("AI에게 보내기", () => runSetupAi(room)), btn("취소", cancel, { ghost: true })),
        aiPicker(true));
    } else if (s.phase === "calling") box.append(empty("AI가 틀을 만드는 중이에요… (최대 2분)"));
    else {
      box.append(h("p", { class: "jmn-error", text: s.error || "문제가 생겼어요." }));
      const acts = h("div", { class: "jmn-actions" });
      if (s.user) acts.append(btn("다시 시도", () => { s.phase = "confirm"; render(); }));
      else acts.append(btn("다시 읽기", () => startGather(room, s)));
      if (!s.rerun) acts.append(btn(state.busy === "setup" ? "만드는 중…" : "빈 틀로 시작", () => startEmpty(room), { ghost: true, disabled: !!state.busy }));
      acts.append(btn("취소", cancel, { ghost: true }));
      box.append(acts);
      if (s.user) box.append(aiUse(), aiPicker(true));
    }
    return box;
  }

  // ── 비밀 ──
  /** 월드 팩이 없는 방에서 비밀 탭으로 가는 작은 링크. */
  function secretLink() {
    return h("div", { class: "jmn-actions jmn-secret-link" },
      btn("비밀 관리", () => openTab("secret"), { ghost: true, nav: true }),
      btn(msgTotal() ? `메시지 (${msgTotal()})` : "메시지", () => openTab("msg"), { ghost: true, nav: true }),
      h("span", { class: "jmn-hint", text: "페르소나 비밀(복선 · 공개)과 콘보 메시지는 주머니를 만들지 않아도 쓸 수 있어요." }));
  }
  function ta(key, props = {}) {
    return h("textarea", { class: "jmn-in jmn-ta", ...props, value: dget(key, ""), oninput: (e) => { draft[key] = e.target.value; } });
  }
  function secretForm(item) {
    return h("form", { class: "jmn-form", onsubmit: (e) => {
      e.preventDefault();
      void secSave(item, String(dget("ps.title")), String(dget("ps.text")), String(dget("ps.clue")));
    } },
    h("b", { text: item ? "비밀 고치기" : "새 비밀" }),
    field("제목", inp("ps.title", { placeholder: "비밀 제목" })),
    field("비밀 내용", ta("ps.text", { rows: "5", placeholder: "원본 비밀 설정" })),
    field("드러나는 단서 (선택)", ta("ps.clue", { rows: "2", maxlength: String(CLUE_MAX), placeholder: "NPC가 볼 수 있는 흔적. 예: 가끔 왼쪽 가슴을 무의식적으로 감싼다 / 여름에도 목까지 잠긴 셔츠만 입는다" })),
    hint("복선 상태일 때만 AI에게 전달돼요."),
    h("div", { class: "jmn-actions" },
      btn(sec.busy ? "저장하는 중…" : "저장", null, { submit: true, disabled: sec.busy }),
      btn("취소", () => { secResetView(); render(); }, { ghost: true })));
  }
  function openSecretForm(item) {
    sec.form = item ? item.entry.id : "new"; sec.confirmDel = "";
    draft["ps.title"] = item ? String(item.entry.name || "") : "";
    draft["ps.text"] = item ? item.meta.originalText : "";
    draft["ps.clue"] = item ? item.meta.clue : "";
    setStatus(""); render();
  }
  function secretCard(item) {
    const id = item.entry.id, name = String(item.entry.name || "") || "제목 없음", st = item.meta.state;
    const open = sec.expanded.has(id) || sec.form === id || sec.confirmDel === id;
    const toggle = h("button", { class: "jmn-secret-toggle", type: "button", "aria-expanded": String(open), onclick: () => {
      if (sec.expanded.has(id)) { sec.expanded.delete(id); if (sec.form === id) secResetView(); sec.confirmDel = ""; } else sec.expanded.add(id);
      render();
    } },
    h("span", { class: "jmn-secret-arrow", "aria-hidden": "true", text: open ? "▾" : "▸" }),
    h("span", { class: "jmn-row-title", text: name }),
    h("span", { class: `jmn-chip jmn-st-${st.toLowerCase()}`, text: stateLabel(st) }));
    const shownSt = sec.pend && sec.pend.id === id ? sec.pend.state : st;
    const states = segPill(`sec:${id}`, PS_STATES.map(stateLabel), Math.max(0, PS_STATES.indexOf(shownSt)),
      (i) => void secSetState(item, PS_STATES[i]), { label: `${name} 상태`, disabled: sec.busy });
    const card = h("div", { class: "jmn-secret" }, h("div", { class: "jmn-secret-head" }, toggle, states));
    if (!open) return card;
    if (sec.form === id) { card.append(secretForm(item)); return card; }
    const det = h("div", { class: "jmn-secret-body" }, h("p", { class: "jmn-pre", text: item.meta.originalText }));
    if (item.meta.clue) det.append(h("p", { class: "jmn-pre jmn-mute", text: `드러나는 단서: ${item.meta.clue}` }));
    det.append(hint(st === "OFF" ? "AI에게 전달하지 않아요." : st === "FORESHADOW" ? "AI에게 전달 · 직접 공개는 안 해요(조사와 복선만)." : "AI에게 공개된 설정으로 전달해요."));
    if (sec.confirmDel === id) {
      det.append(h("div", { class: "jmn-form" },
        h("b", { text: `‘${name}’ 비밀을 지울까요?` }),
        hint("로어북 항목이 지워지고 되돌릴 수 없어요."),
        h("div", { class: "jmn-actions" },
          btn(sec.busy ? "지우는 중…" : "지우기", () => void secDelete(item), { danger: true, disabled: sec.busy }),
          btn("취소", () => { sec.confirmDel = ""; render(); }, { ghost: true }))));
    } else {
      det.append(h("div", { class: "jmn-actions" },
        btn("편집", () => openSecretForm(item), { ghost: true, disabled: sec.busy }),
        btn("삭제", () => { sec.confirmDel = id; sec.form = null; render(); }, { ghost: true, danger: true, disabled: sec.busy, label: `${name} 삭제` })));
    }
    card.append(det);
    return card;
  }
  function secretTab(room) {
    secEnsure(room);
    const box = h("div", { class: "jmn-body" });
    if (!room.data) box.append(h("div", { class: "jmn-actions" }, btn("← 주머니 만들기", () => { state.tab = "wallet"; secResetView(); setStatus(""); render(); }, { ghost: true, nav: true })));
    if (otherSecretsOn()) box.append(h("p", { class: "jmn-error", role: "alert", text: PS_WARN }));
    const list = sec.personas || [];
    const cur = list.find((p) => p.id === sec.personaId);
    const options = [["", "페르소나를 고르세요"], ...list.map((p) => [p.id, str(p.name, 60) || "이름 없음"])];
    if (sec.personaId && !cur) options.push([sec.personaId, sec.personas ? "(목록에 없는 페르소나)" : "이 방의 페르소나"]);
    const pick = h("select", { class: "jmn-in", disabled: !!sec.loading || sec.busy, onchange: (e) => {
      sec.picked = true; sec.personaId = e.target.value; sec.loadedFor = null; sec.error = ""; secResetView(); setStatus(""); render();
    } }, options.map(([v, l]) => h("option", { value: v, text: l })));
    pick.value = sec.personaId;
    box.append(h("div", { class: "jmn-ai-row" }, field("페르소나", pick),
      btn(sec.loading === "personas" ? "불러오는 중…" : "목록 새로고침", () => { sec.personas = null; sec.personaErr = ""; render(); }, { ghost: true, disabled: !!sec.loading || sec.busy })));
    const chat = room.chat || {};
    if (!chat.personaId) box.append(hint(chat.personaCharacterId
      ? "이 방은 페르소나 대신 캐릭터 카드를 내 캐릭터로 써요. 비밀을 둘 페르소나를 위에서 골라 주세요."
      : "이 방에는 페르소나가 없어요. 비밀을 둘 페르소나를 위에서 골라 주세요."));
    else if (sec.personaId && sec.personaId !== chat.personaId) box.append(hint("이 방의 페르소나가 아닌 다른 페르소나를 보고 있어요."));
    box.append(hint("이 페르소나의 모든 방에 적용돼요. (방마다 따로가 아니에요)"));
    if (sec.personaErr) box.append(h("p", { class: "jmn-error", text: sec.personaErr }));
    if (!sec.personaId) { box.append(empty("페르소나를 고르면 그 페르소나의 비밀이 보여요.")); return box; }
    if (sec.loading) { box.append(empty("불러오는 중이에요…")); return box; }
    if (sec.error) {
      box.append(h("p", { class: "jmn-error", text: sec.error }),
        h("div", { class: "jmn-actions" }, btn("다시 불러오기", () => { sec.loadedFor = null; sec.error = ""; render(); }, { ghost: true })));
      return box;
    }
    const pname = cur ? (str(cur.name, 60) || "이름 없음") : "고른 페르소나";
    box.append(h("div", { class: "jmn-sec" }, h("b", { text: `‘${pname}’의 비밀` }), h("span", { text: `${sec.secrets.length}개` }),
      sec.form === "new" ? null : btn("+ 새 비밀", () => openSecretForm(null), { disabled: sec.busy })));
    if (sec.form === "new") box.append(secretForm(null));
    if (!sec.secrets.length) box.append(empty("아직 저장된 비밀이 없어요."));
    for (const item of sec.secrets) box.append(secretCard(item));
    box.append(hint("지침은 상태마다 한 번만 들어가요."));
    return box;
  }

  // ── 지갑 ──
  function walletTab(room) {
    const d = room.data, pc = pcWallet(d), npcs = npcWallets(d);
    const left = h("div", { class: "jmn-col" });
    const bals = h("div", { class: "jmn-bals" });
    for (const w of d.wallets) {
      const sal = w.salary && w.salary.amount > 0 ? ` · 월급 ${w.salary.when || ""}`.trimEnd() : "";
      bals.append(h("div", { class: `jmn-bal jmn-glass${w.who === "pc" ? " jmn-bal-pc" : ""}` }, h("small", { text: `${w.name}의 잔고` }), countNum(`${room.id}:${w.id}`, w.balance), h("small", { text: `${d.pack.currency}${sal}` })));
    }
    if (d.pack.statName) bals.append(h("div", { class: "jmn-bal jmn-bal-stat jmn-glass" }, h("small", { text: d.pack.statName }), countNum(`${room.id}:stat`, d.stat)));
    left.append(bals);
    const act = (id, label) => btn(label, () => { state.wact = state.wact === id ? null : id; setStatus(""); render(); }, { ghost: state.wact !== id, disabled: (id === "send" || id === "recv") && !npcs.length });
    left.append(h("div", { class: "jmn-actions" }, act("send", "송금"), act("recv", "NPC에게 받기"), act("in", "직접 입금"), act("out", "직접 출금")));
    if (state.wact) {
      const mode = state.wact, withNpc = mode === "send" || mode === "recv";
      const title = { send: "내 통장 → NPC 통장", recv: "NPC 통장 → 내 통장", in: "내 통장에 직접 입금 (수정용)", out: "내 통장에서 직접 출금 (수정용)" }[mode];
      left.append(h("form", { class: "jmn-form", onsubmit: (e) => { e.preventDefault(); doWallet(room, mode); } },
        h("b", { text: title }),
        withNpc ? field(mode === "send" ? "받는 사람" : "주는 사람", sel("w.npc", npcs.map((w) => [w.id, `${w.name} (${fmt(w.balance)})`]), npcs[0]?.id)) : null,
        field(`금액 (${d.pack.currency})`, inp("w.amt", { inputmode: "numeric", placeholder: "0" })),
        field("메모", inp("w.memo", { maxlength: "60", placeholder: withNpc ? "선택" : "예: 잔고 맞추기" })),
        h("div", { class: "jmn-actions" }, btn("확인", null, { submit: true }), btn("취소", () => { state.wact = null; render(); }, { ghost: true }))));
    }
    const right = h("div", { class: "jmn-col jmn-glass jmn-ledger" });
    const FILTERS = [["all", "전체"], ["in", "입금"], ["out", "출금"]];
    right.append(h("div", { class: "jmn-sec" }, h("b", { text: "내역" }),
      segPill(`filter:${room.id}`, FILTERS.map((x) => x[1]), Math.max(0, FILTERS.findIndex((x) => x[0] === state.filter)), (i) => { state.filter = FILTERS[i][0]; render(); }, { label: "내역 거르기", nav: true })));
    const list = d.ledger.filter((e) => state.filter === "all" || (e.walletId === pc.id && (state.filter === "in" ? e.amount > 0 : e.amount < 0)));
    if (!list.length) right.append(empty("아직 내역이 없어요."));
    const rk = `ledger:${room.id}`;
    freshRows(rk, d.ledger.map((e) => e.id));
    for (const e of list.slice(0, 60)) {
      const mine = e.walletId === pc.id;
      const owner = mine ? "" : (d.wallets.find((w) => w.id === e.walletId)?.name || "NPC");
      right.append(rowIn(row(e.title, [e.sub, owner ? `${owner} 통장` : "", e.rp ? `작중 ${e.rp}` : fmtTime(e.ts)].filter(Boolean).join(" · "),
        numEl(signed(e.amount), !mine ? "jmn-mute" : e.amount > 0 ? "jmn-plus" : e.amount < 0 ? "jmn-minus" : ""),
        e.k === "auto" ? h("button", { class: "jmn-btn jmn-ghost jmn-undo", type: "button", text: "되돌리기", "aria-label": `${e.title} 자동 반영 되돌리기`, onclick: () => undoAuto(room, e) }) : null), rk, e.id));
    }
    return h("div", { class: "jmn-body jmn-cols jmn-wallet" }, left, right);
  }
  function doWallet(room, mode) {
    const d = room.data, pc = pcWallet(d);
    const amt = num(dget("w.amt")), memo = str(dget("w.memo"), 60);
    if (amt < 1) return fail("금액을 1 이상의 숫자로 적어 주세요.");
    const done = (fn, msg) => { delete draft["w.amt"]; delete draft["w.memo"]; state.wact = null; edit(room, fn, msg); };
    if (mode === "send" || mode === "recv") {
      const npcs = npcWallets(d);
      const npc = npcs.find((w) => w.id === dget("w.npc")) || npcs[0];
      if (!npc) return fail("NPC 통장이 없어요.");
      if (mode === "send") {
        if (pc.balance < amt) return fail(`내 잔고가 부족해요. 보낼 금액 ${money(d, amt)}, 내 잔고 ${money(d, pc.balance)}`);
        return done(() => { pc.balance -= amt; npc.balance += amt; addLedger(d, { title: `${npc.name}에게 송금`, sub: memo || "나 → NPC", amount: -amt, walletId: pc.id, k: "xfer" }); }, `${npc.name}에게 ${money(d, amt)}을(를) 보냈어요.`);
      }
      if (npc.balance < amt) return fail(`${npc.name}의 잔고가 부족해요. 받을 금액 ${money(d, amt)}, ${npc.name} 잔고 ${money(d, npc.balance)}`);
      return done(() => { npc.balance -= amt; pc.balance += amt; addLedger(d, { title: `${npc.name}에게 받음`, sub: memo || "NPC → 나", amount: amt, walletId: pc.id, k: "xfer" }); }, `${npc.name}에게 ${money(d, amt)}을(를) 받았어요.`);
    }
    if (mode === "out") {
      if (pc.balance < amt) return fail(`내 잔고가 부족해요. 내 잔고 ${money(d, pc.balance)}`);
      return done(() => { pc.balance -= amt; addLedger(d, { title: memo || "직접 출금", sub: "직접 수정", amount: -amt, walletId: pc.id, k: "manual" }); }, "출금했어요.");
    }
    return done(() => { pc.balance += amt; addLedger(d, { title: memo || "직접 입금", sub: "직접 수정", amount: amt, walletId: pc.id, k: "manual" }); }, "입금했어요.");
  }

  // ── 상점 · 배달 ──
  function deliveryRows(d) {
    return d.deliveries.map((x) => row(deliveryLabel(x), `${x.shopName || "배달"} · ${x.stage === 2 ? "다음 답장에 도착해요" : "다음 답장부터 조리해요"}`, chip(x.stage === 2 ? "조리·배달 중" : "주문 접수", true)));
  }
  function shopTab(room) {
    const d = room.data;
    const box = h("div", { class: "jmn-body" });
    if (d.deliveries.length) box.append(section("배달 오는 중", `${d.deliveries.length}건`), ...deliveryRows(d));
    const shop = d.pack.shops.find((s) => s.id === state.shopId);
    if (!shop) {
      box.append(section("가게", `${d.pack.shops.length}곳`));
      if (!d.pack.shops.length) box.append(empty("가게가 없어요. 설정 탭에서 가게와 품목을 추가해 보세요."));
      for (const s of d.pack.shops) {
        box.append(row(s.name, [s.kind === "delivery" ? "배달" : "상점", s.desc, `품목 ${s.items.length}개`].filter(Boolean).join(" · "),
          btn("들어가기", () => { state.shopId = s.id; state.buy = null; setStatus(""); render(); }, { nav: true, ghost: true })));
      }
      box.append(restockHint(), aiUse());
      return box;
    }
    box.append(h("div", { class: "jmn-sec" }, h("b", { text: shop.name }), h("span", { text: shop.kind === "delivery" ? "배달 · 두 번의 답장 뒤 도착" : "상점 · 바로 가방으로" }),
      btn("← 가게 목록", () => { state.shopId = ""; state.buy = null; setStatus(""); render(); }, { nav: true, ghost: true })));
    if (shop.desc) box.append(hint(shop.desc));
    if (!shop.items.length) box.append(empty("품목이 없어요. 설정 탭에서 추가해 보세요."));
    for (const it of shop.items) {
      if (it.stock === 0) {
        const busy = restockBusy(it.id);
        // 새 물건을 들여오는 동안 줄이 반짝인다.
        box.append(addCls(row(it.name, busy ? "품절 · 새 물건 들여오는 중…" : "품절 · 새 물건을 아직 못 들였어요", h("span", { class: "jmn-chip jmn-chip-out", text: "품절" }),
          busy ? btn("들여오는 중…", null, { disabled: true }) : btn("새 물건 들이기", () => {
            if (queueRestock(room, shop.id, it.id)) { setStatus(`‘${it.name}’ 자리에 들일 새 물건을 AI에게 묻는 중이에요…`); render(); }
          }),
          busy ? null : btn("직접 채우기", () => { state.tab = "set"; state.editShopId = shop.id; state.buy = null; setStatus("품목 이름 · 가격 · 재고를 고쳐 주세요. 재고를 1 이상으로 하면 다시 팔아요."); render(); }, { ghost: true })), `jmn-card${busy ? " jmn-soldout" : ""}`));
        continue;
      }
      const buying = state.buy && state.buy.itemId === it.id;
      const sub = [shop.kind === "delivery" ? "배달" : "", it.note || ""].filter(Boolean).join(" · ") || null;
      // 재고가 줄면 숫자가 위에서 떨어지듯 바뀐다.
      const prevStock = stockSeen.get(it.id);
      stockSeen.set(it.id, it.stock);
      if (prevStock != null && it.stock != null && it.stock < prevStock) fxMark(`stock:${it.id}`);
      const stockChip = it.stock == null ? null : h("span", { class: "jmn-chip jmn-chip-stock" }, "재고 ", fxCls(h("span", { class: "jmn-stock-n", text: fmt(it.stock) }), `stock:${it.id}`, "jmn-flip", 350));
      // AI가 새로 들인 물건: 상점 탭을 떠날 때까지 ‘NEW’ 표시(튀어나오는 움직임은 한 번만).
      const isNew = newItems.get(it.id);
      const r = rowTag(it.name, isNew != null ? lag(h("span", { class: "jmn-newchip", text: "NEW" }), isNew) : null, sub, stockChip, numEl(money(d, it.price)), buyButton(it, shop, buying));
      addCls(r, "jmn-card");
      if (isNew != null && Date.now() - isNew < 450) lag(addCls(r, "jmn-rowin"), isNew);
      box.append(r);
      if (buying) {
        const maxQty = it.stock == null ? 99 : Math.min(99, it.stock);
        const totalText = (v) => { const n = Math.max(1, num(v)); return n > maxQty ? (it.stock != null && n > it.stock ? `재고 ${fmt(it.stock)}개까지` : `${maxQty}개까지`) : money(d, it.price * n); };
        const total = h("span", { class: "jmn-num jmn-coin", text: totalText(dget("b.qty", "1")) });
        const qty = inp("b.qty", { def: "1", inputmode: "numeric", "aria-label": it.stock == null ? "수량" : `수량 (재고 ${it.stock}개)`, max: String(maxQty) });
        qty.addEventListener("input", () => { total.textContent = totalText(qty.value); });
        box.append(h("form", { class: "jmn-form", onsubmit: (e) => { e.preventDefault(); doBuy(room, shop, it); } },
          h("div", { class: "jmn-form-grid" },
            field("수량", qty),
            field("결제할 통장", sel("b.payer", d.wallets.map((w) => [w.id, w.who === "pc" ? `내 통장 (${fmt(w.balance)})` : `${w.name}가 계산 (${fmt(w.balance)})`]), pcWallet(d).id))),
          h("div", { class: "jmn-actions" }, h("span", { class: "jmn-mute", text: "합계" }), total, btn(shop.kind === "delivery" ? "주문하기" : "구매하기", null, { submit: true }))));
      }
    }
    box.append(restockHint(), aiUse());
    return box;
  }
  const restockHint = () => hint("품목이 다 팔리면 AI가 새 물건을 한 번 만들어요 (호출 1번).");
  const stockSeen = new Map(); // 품목 id → 마지막으로 그린 재고(숫자 넘김용)
  // 구매 버튼: 구매 → 결제 중(아래 줄이 차오름, 저장이 끝날 때까지 · 적어도 600ms) → ✓ 완료(900ms) → 구매.
  // 화면만 바뀐다. 실제 구매는 ‘구매하기’를 누를 때 지금처럼 바로 처리된다.
  const buyFx = new Map(); // 품목 id → { roomId, t0, phase, minOk, saved }
  function buyButton(it, shop, buying) {
    const fx = buyFx.get(it.id);
    if (fx) {
      const paying = fx.phase === "paying";
      const b = btn(paying ? "결제 중" : "✓ 완료", null, { disabled: true, cls: paying ? "jmn-paying" : "jmn-paid" });
      if (paying) b.append(lag(h("span", { class: "jmn-fill", "aria-hidden": "true" }), fx.t0));
      else lag(b, fx.t0);
      return b;
    }
    return btn(buying ? "닫기" : shop.kind === "delivery" ? "주문" : "구매", () => { state.buy = buying ? null : { itemId: it.id }; draft["b.qty"] = "1"; setStatus(""); render(); }, { ghost: buying, cls: "jmn-buy" });
  }
  function buyFxStart(room, itemId) {
    if (calm()) return;
    const fx = { roomId: room.id, t0: Date.now(), phase: "paying", minOk: false, saved: false };
    buyFx.set(itemId, fx);
    later(() => { fx.minOk = true; buyFxStep(itemId, fx); }, 600);
    // 저장 소식이 오지 않아도 버튼이 묶여 있지 않게(안전장치).
    later(() => { fx.saved = true; buyFxStep(itemId, fx); }, 6000);
  }
  function buyFxStep(itemId, fx) {
    if (buyFx.get(itemId) !== fx || fx.phase !== "paying" || !fx.minOk || !fx.saved) return;
    fx.phase = "done"; fx.t0 = Date.now();
    softRender();
    later(() => { if (buyFx.get(itemId) === fx) { buyFx.delete(itemId); softRender(); } }, 900);
  }
  function buyFxSaved(room) {
    for (const [id, fx] of buyFx) if (fx.roomId === room.id && !fx.saved) { fx.saved = true; buyFxStep(id, fx); }
  }
  function doBuy(room, shop, it) {
    const d = room.data;
    if (it.stock === 0) return fail(`${it.name}은(는) 다 팔렸어요.`);
    const want = Math.max(1, num(dget("b.qty", "1")));
    if (it.stock != null && want > it.stock) return fail(`${it.name}은(는) 재고가 ${fmt(it.stock)}개뿐이에요.`);
    const qty = Math.min(99, want);
    const payer = d.wallets.find((w) => w.id === dget("b.payer")) || pcWallet(d);
    const total = it.price * qty;
    const who = payer.who === "pc" ? "내" : `${payer.name}의`;
    if (payer.balance < total) return fail(`${who} 잔고가 부족해요. 필요한 금액 ${money(d, total)}, ${who} 잔고 ${money(d, payer.balance)}`);
    const isDelivery = shop.kind === "delivery";
    if (isDelivery && d.deliveries.length >= CAP.deliveries) return fail("배달이 너무 많이 밀려 있어요. 도착한 뒤에 다시 주문해 주세요.");
    const label = `${it.name}${qty > 1 ? ` ${qty}개` : ""}`;
    const soldOut = it.stock != null && it.stock - qty <= 0;
    state.buy = null; delete draft["b.qty"];
    if (!soldOut) buyFxStart(room, it.id);
    edit(room, () => {
      payer.balance -= total;
      addLedger(d, { title: label, sub: `${isDelivery ? "배달" : "상점"} · ${shop.name}${payer.who === "pc" ? "" : ` · ${payer.name}가 계산`}`, amount: -total, walletId: payer.id, k: "buy" });
      if (isDelivery) d.deliveries.push({ id: uid(), itemName: it.name, shopName: shop.name, qty, stage: 1 });
      else addBag(d, it.name, qty);
      if (it.stock != null) {
        setStock(it, Math.max(0, it.stock - qty));
        if (soldOut) shop.soldOutHistory = [...arr(shop.soldOutHistory), it.name].slice(-CAP.soldOut);
      }
    }, `${isDelivery ? `${label}을(를) 주문했어요. 두 번의 답장 뒤에 가방에 들어와요.` : `${label}을(를) 샀어요. 가방에 넣었어요.`}${soldOut ? " 다 팔려서 AI가 새 물건을 들여오는 중이에요." : ""}`);
    // 산 결과로 다 팔렸을 때만 AI를 한 번 부른다(지금 방에서만, 차례로).
    if (soldOut) queueRestock(room, shop.id, it.id);
  }

  // ── 가방 ──
  // 배달 단계 표시: 점 세 개(주문 접수 · 조리 · 배달 중 · 도착 · 가방으로)와 600ms 동안 차오르는 줄.
  const DELIV_PCT = [0, 6, 50, 100];
  const delivSeen = new Map(); // 배달 id → 마지막으로 그린 단계
  const lastDeliv = new Map(); // 방 id → 지난번 그림의 배달들(도착 알아채기용)
  const arrived = new Map(); // 방 id → 방금 도착한 배달들(가방 탭을 떠날 때까지)
  /** 지난번 그림에 있던 배달이 사라지고 그 물건이 가방에 있으면 ‘도착’으로 본다(화면만). */
  function trackDeliveries(room) {
    const d = room.data;
    const prev = lastDeliv.get(room.id);
    lastDeliv.set(room.id, d.deliveries.map((x) => ({ ...x })));
    if (!prev) return;
    const now = new Set(d.deliveries.map((x) => x.id));
    const got = prev.filter((x) => !now.has(x.id) && d.bag.some((b) => b.name === x.itemName));
    if (got.length) arrived.set(room.id, [...(arrived.get(room.id) || []), ...got].slice(-CAP.deliveries));
  }
  function deliveryCard(x, stage) {
    const prev = delivSeen.get(x.id);
    delivSeen.set(x.id, stage);
    const fill = h("i");
    slideFrom(fill, "width", prev == null ? null : `${DELIV_PCT[prev]}%`, `${DELIV_PCT[stage]}%`);
    const STEPS = ["주문 접수", "조리 · 배달 중", "도착 · 가방으로"];
    const sub = stage === 3 ? "도착해서 가방에 넣었어요" : stage === 2 ? "다음 답장에 도착해요" : "다음 답장부터 조리해요";
    return h("div", { class: "jmn-deliv", role: "group", "aria-label": `${deliveryLabel(x)} 배달 · ${STEPS[stage - 1]}` },
      h("div", { class: "jmn-deliv-head" }, h("span", { class: "jmn-row-title", text: deliveryLabel(x) }), h("small", { text: `${x.shopName || "배달"} · ${sub}` })),
      h("div", { class: "jmn-stepbar", "aria-hidden": "true" }, fill),
      h("div", { class: "jmn-steps", "aria-hidden": "true" }, STEPS.map((t, i) => h("span", { class: "jmn-step" }, h("span", { class: `jmn-dot${stage >= i + 1 ? " jmn-on" : ""}` }), h("span", { text: t })))));
  }
  const using = new Map(); // 가방 id → 사용을 누른 때(사라지는 움직임 500ms)
  function useItem(room, b, e) {
    if (using.has(b.id)) return;
    const go = () => {
      using.delete(b.id);
      if (!room.data || !room.data.bag.includes(b)) { softRender(); return; }
      edit(room, (x) => { b.qty -= 1; if (b.qty <= 0) x.bag = x.bag.filter((y) => y.id !== b.id); x.usedNote = `방금 ${b.name}을(를) 사용했다.`; }, `${b.name}을(를) 사용했어요. 다음 답장 한 번에만 전달돼요.`);
    };
    // 하나 남은 것만 사라지는 움직임. 여러 개면 바로 줄어든다.
    if (b.qty > 1 || calm()) return go();
    using.set(b.id, Date.now());
    const r = e?.currentTarget?.closest?.(".jmn-row");
    if (r) { addCls(r, "jmn-used"); for (const x of r.querySelectorAll("button")) x.disabled = true; }
    later(go, 500);
  }
  function bagTab(room) {
    const d = room.data;
    const box = h("div", { class: "jmn-body" });
    const arr2 = arrived.get(room.id) || [];
    if (d.deliveries.length || arr2.length) {
      box.append(section("배달 오는 중", `${d.deliveries.length}건`));
      for (const x of d.deliveries) box.append(deliveryCard(x, x.stage === 2 ? 2 : 1));
      for (const x of arr2) box.append(deliveryCard(x, 3));
    }
    box.append(section("가방", `${d.bag.length}종류`));
    if (!d.bag.length) box.append(empty("가방이 비어 있어요. 상점에서 물건을 사 보세요."));
    const rk = `bag:${room.id}`;
    freshRows(rk, d.bag.map((b) => b.id));
    for (const b of d.bag) {
      const r = rowIn(row(b.name, null, numEl(`${fmt(b.qty)}개`),
        btn("사용", (e) => useItem(room, b, e)),
        btn("삭제", () => edit(room, (x) => { x.bag = x.bag.filter((y) => y.id !== b.id); }, `${b.name}을(를) 가방에서 뺐어요.`), { ghost: true, danger: true, label: `${b.name} 삭제` })), rk, b.id);
      // 마지막 하나를 쓰는 중이면 오른쪽으로 미끄러지며 사라진다.
      const u = using.get(b.id);
      if (u != null) { lag(addCls(r, "jmn-used"), u); for (const x of r.querySelectorAll?.("button") || []) x.disabled = true; }
      box.append(r);
    }
    if (d.usedNote) box.append(hint(`다음 답장 때 자동으로 전달돼요(따로 입력할 필요 없어요): ${d.usedNote}`));
    return box;
  }

  // ── 퀘스트 ──
  const questFx = new Map(); // 임무 id → { t0, plus } (완료 도장 · 보상 숫자, 1.2초)
  /** 임무 완료: 보상(내 통장 · 내역 · 성장 수치), 상태 done, 완료 제안 지우기. */
  function completeQuest(room, q) {
    const d = room.data;
    if (!d) return;
    if (q.status === "done") return;
    // ‘완료’ 도장 + 보상 숫자가 떠오르는 동안(1.2초)은 카드를 그 자리에 두고, 그다음 그림에서 완료 칸으로 옮긴다.
    if (!calm()) {
      questFx.set(q.id, { t0: Date.now(), plus: q.rewardMoney > 0 ? `+${fmt(q.rewardMoney)}` : "" });
      later(() => { questFx.delete(q.id); fxMark(`row:quest:${room.id}:${q.id}:done`); softRender(); }, 1250);
    }
    edit(room, (x) => {
      const pc = pcWallet(x);
      q.status = "done"; q.doneSuggested = "";
      x.quests = [q, ...x.quests.filter((y) => y.id !== q.id)];
      const doneAll = x.quests.filter((y) => y.status === "done");
      if (doneAll.length > CAP.done) { const dropIds = new Set(doneAll.slice(CAP.done).map((y) => y.id)); x.quests = x.quests.filter((y) => !dropIds.has(y.id)); }
      if (q.rewardMoney > 0) { pc.balance += q.rewardMoney; addLedger(x, { title: `임무 완료: ${q.title}`, sub: "퀘스트 보상", amount: q.rewardMoney, walletId: pc.id, k: "quest" }); }
      if (q.rewardStat > 0 && x.pack.statName) x.stat += q.rewardStat;
    }, `‘${q.title}’ 완료! ${rewardText(d, q) || "보상 없음"}`);
  }
  function questTab(room) {
    const d = room.data;
    const box = h("div", { class: "jmn-body" });
    box.append(h("div", { class: "jmn-actions" },
      btn(state.busy === "ai" ? "받는 중…" : "새 퀘스트 받기", () => askQuests(room), { disabled: !!state.busy }),
      btn("직접 추가", () => { state.questForm = !state.questForm; render(); }, { ghost: !state.questForm })));
    box.append(hint("‘새 퀘스트 받기’는 누를 때마다 AI를 한 번 불러요(세계관 자료 약 1,500 토큰 + 지금 틀 요약)."), aiUse());
    if (state.questForm) {
      box.append(h("form", { class: "jmn-form", onsubmit: (e) => {
        e.preventDefault();
        const title = str(dget("q.title"), 100);
        if (!title) return fail("임무 제목을 적어 주세요.");
        const q = normQuest({ title, giver: dget("q.giver"), rewardMoney: dget("q.money"), rewardStat: d.pack.statName ? dget("q.stat") : 0, desc: dget("q.desc") }, "offered");
        for (const k of ["q.title", "q.giver", "q.money", "q.stat", "q.desc"]) delete draft[k];
        state.questForm = false;
        edit(room, (x) => { x.quests = [q, ...x.quests].slice(0, CAP.quests); }, "새 임무를 추가했어요.");
      } },
      h("div", { class: "jmn-form-grid" },
        field("제목", inp("q.title", { maxlength: "100", placeholder: "예: 수박 5개 가져다주기" })),
        field("의뢰인", inp("q.giver", { maxlength: "60", placeholder: "예: 촌장" })),
        field(`보상 (${d.pack.currency})`, inp("q.money", { inputmode: "numeric", placeholder: "0" })),
        d.pack.statName ? field(`보상 (${d.pack.statName})`, inp("q.stat", { inputmode: "numeric", placeholder: "0" })) : null),
      field("설명", inp("q.desc", { maxlength: "240", placeholder: "선택" })),
      h("div", { class: "jmn-actions" }, btn("추가", null, { submit: true }), btn("취소", () => { state.questForm = false; render(); }, { ghost: true }))));
    }
    const sub = (q) => [q.giver, rewardText(d, q), q.desc].filter(Boolean).join(" · ");
    const remove = (q, label, msg) => btn(label, () => edit(room, (x) => { x.quests = x.quests.filter((y) => y.id !== q.id); }, msg), { ghost: true, danger: true });
    const offered = d.quests.filter((q) => q.status === "offered"), active = d.quests.filter((q) => q.status === "active");
    // 방금 끝낸 임무(도장 찍는 중)는 잠깐 진행 중 칸에 남는다.
    const stamping = d.quests.filter((q) => q.status === "done" && questFx.has(q.id));
    const done = d.quests.filter((q) => q.status === "done" && !questFx.has(q.id)).slice(0, 10);
    const rk = `quest:${room.id}`;
    freshRows(rk, d.quests.map((q) => `${q.id}:${q.status}`));
    const card = (q, ...right) => rowIn(addCls(row(q.title, sub(q), ...right), "jmn-card jmn-qcard"), rk, `${q.id}:${q.status}`);
    const suggested = active.filter((q) => q.doneSuggested);
    if (suggested.length) {
      const sug = h("div", { class: "jmn-suggest" }, section("완료된 것 같아요", `${suggested.length}개`),
        hint("답장 끝에 완료 표시가 있었어요. 맞으면 ‘완료’를 눌러 보상을 받고, 아니면 ‘아직 아니에요’를 눌러 주세요."));
      for (const q of suggested) {
        sug.append(row(q.title, sub(q),
          btn("완료", () => completeQuest(room, q)),
          btn("아직 아니에요", () => edit(room, () => { q.doneSuggested = ""; }, `‘${q.title}’ 임무는 계속 진행해요.`), { ghost: true })));
      }
      box.prepend(sug);
    }
    box.append(section("새 임무", `${offered.length}개`));
    if (!offered.length) box.append(empty("새 임무가 없어요."));
    for (const q of offered) box.append(addCls(card(q, btn("받기", () => edit(room, () => { q.status = "active"; }, `‘${q.title}’ 임무를 받았어요.`)), remove(q, "포기", "임무를 지웠어요.")), "jmn-offer"));
    box.append(section("진행 중", `${active.length}개`));
    if (!active.length && !stamping.length) box.append(empty("진행 중인 임무가 없어요."));
    for (const q of stamping) {
      const fx = questFx.get(q.id);
      const c = addCls(row(q.title, sub(q), btn("보상 받음", null, { ghost: true, disabled: true })), "jmn-card jmn-qcard jmn-stamped");
      c.append(lag(h("span", { class: "jmn-stamp", "aria-hidden": "true", text: "완료" }), fx.t0));
      if (fx.plus) c.append(lag(h("span", { class: "jmn-floatup jmn-num", "aria-hidden": "true", text: fx.plus }), fx.t0));
      box.append(c);
    }
    for (const q of active) {
      box.append(card(q, btn("완료", () => completeQuest(room, q)), remove(q, "포기", "임무를 포기했어요.")));
    }
    box.append(section("완료", `최근 ${done.length}개`));
    if (!done.length) box.append(empty("완료한 임무가 없어요."));
    for (const q of done) box.append(rowIn(row(q.title, sub(q), chip("완료")), rk, `${q.id}:${q.status}`));
    return box;
  }

  // ── 설정 ──
  function setIn(room, value, apply, props = {}) {
    return h("input", { class: "jmn-in", type: "text", autocomplete: "off", ...props, value, onchange: (e) => quietEdit(room, (d) => apply(d, e.target.value, e.target)) });
  }
  function settingsTab(room) {
    const d = room.data;
    const box = h("div", { class: "jmn-body" });
    box.append(hint("칸을 고치고 다른 곳을 누르면 저장돼요."));
    const flipSend = () => { const on = !d.send; markSaved("send"); edit(room, (x) => { x.send = on; }, on ? "지금 상태를 RP에 숨김 메시지로 전달해요." : "RP에 전달하지 않아요. 숨김 메시지를 지워요."); };
    const flipMoney = () => { const on = !d.autoMoney; markSaved("money"); edit(room, (x) => { x.autoMoney = on; }, on ? "RP 속에서 돈이 오가면 답장 끝 표시를 읽어 잔고에 바로 반영해요. 지갑 내역에서 되돌릴 수 있어요." : "RP 속 돈 흐름을 자동으로 반영하지 않아요."); };
    const flipBridge = () => { const on = !d.convoBridge; markSaved("bridge"); edit(room, (x) => { x.convoBridge = on; }, on ? "연결된 콘보에서 주고받은 최근 문자를 다음 RP 답장에 참고로 전달해요." : "콘보 대화를 RP에 전달하지 않아요."); };
    box.append(h("div", { class: "jmn-swlist" },
      switchRow("send", "RP에 전달", "지갑 · 가방 · 임무 · 배달 상태를 숨김 메시지로 알려 줘요", d.send, flipSend),
      switchRow("money", "RP 속 돈 흐름 자동 반영", "답장 끝의 [송금] · [입금] · [출금] 표시를 바로 반영해요", d.autoMoney, flipMoney),
      switchRow("bridge", "콘보 대화를 RP에 알려주기", "연결된 콘보에서 주고받은 최근 문자를 다음 RP 답장에 참고로 전달해요.", d.convoBridge, flipBridge),
      h("div", { class: "jmn-swrow" },
        h("div", { class: "jmn-row-main" }, h("span", { class: "jmn-row-title", text: "통장 내역을 RP에 알려주기" }), h("small", { text: "최근 몇 건을 숨김 메시지로 전달할지 골라요. 10건이면 답장마다 약 200토큰 늘어요" })),
        savedEl("ledger"),
        segPill("ledger", ["끔", "5건", "10건", "20건"], Math.max(0, [0, 5, 10, 20].indexOf(d.ledgerShare || 0)), (i) => { const n = [0, 5, 10, 20][i]; markSaved("ledger"); edit(room, (x) => { x.ledgerShare = n; }, n ? `통장 내역 최근 ${n}건을 RP에 전달해요.` : "통장 내역은 최근 거래 1~2건만 전달해요."); }, { label: "통장 내역 건수", nav: true })),
      h("div", { class: "jmn-swrow" },
        h("div", { class: "jmn-row-main" }, h("span", { class: "jmn-row-title", text: "화면 색" }), h("small", { text: "이 브라우저의 모든 방에 똑같이 적용돼요" })),
        savedEl("tone"),
        segPill("tone", ["먹색", "흑백"], tone === "paper" ? 1 : 0, (i) => setTone(i === 1 ? "paper" : "ink"), { label: "화면 색", nav: true }))));
    box.append(hint("답장 끝 신호를 놓치면 다음에 창을 열거나 입력을 시작할 때 반영돼요."));
    box.append(hint(d.send ? "켜 두면 AI가 답장 끝에 [송금/입금/출금: …]을 붙이고, 주머니가 그 줄을 읽어 잔고에 반영한 뒤 지워요(답장마다 최근 메시지 1번 읽기)." : "‘RP에 전달’이 꺼져 있으면 자동 반영도 쉬어요."));

    box.append(section("기본"));
    box.append(h("div", { class: "jmn-form-grid" },
      field("화폐 이름", setIn(room, d.pack.currency, (x, v, el) => { x.pack.currency = str(v, 20) || "골드"; el.value = x.pack.currency; }, { maxlength: "20" })),
      field("성장 수치 이름 (없으면 비움)", setIn(room, d.pack.statName, (x, v) => { x.pack.statName = str(v, 30); }, { maxlength: "30", placeholder: "예: 등급 경험치" })),
      field("성장 수치 값", setIn(room, String(d.stat), (x, v, el) => { x.stat = num(v); el.value = String(x.stat); }, { inputmode: "numeric" }))));

    box.append(section("통장"));
    for (const w of d.wallets) {
      box.append(h("div", { class: "jmn-form-grid" },
        field(w.who === "pc" ? "내 통장 이름" : "NPC 통장 이름", setIn(room, w.name, (x, v, el) => { w.name = str(v, 40) || w.name; el.value = w.name; }, { maxlength: "40" })),
        field(`잔고 (${d.pack.currency})`, setIn(room, String(w.balance), (x, v, el) => { w.balance = num(v); el.value = String(w.balance); }, { inputmode: "numeric" }))));
      // 월급: 세 칸 모두 비우면 없음. 금액이 있을 때만 숨김 전달에 들어간다.
      const setSalary = (key, v, el) => {
        const cur = w.salary || { amount: 0, when: "", from: "" };
        const nextS = normSalary({ ...cur, [key]: v });
        if (nextS) w.salary = nextS; else delete w.salary;
        el.value = key === "amount" ? (w.salary?.amount ? String(w.salary.amount) : "") : (w.salary?.[key] || "");
      };
      const sal = w.salary || {};
      box.append(h("div", { class: "jmn-salary" },
        setIn(room, sal.amount ? String(sal.amount) : "", (x, v, el) => setSalary("amount", v, el), { inputmode: "numeric", placeholder: "월급", "aria-label": `${w.name} 월급 금액`, class: "jmn-in jmn-in-price" }),
        setIn(room, sal.when || "", (x, v, el) => setSalary("when", v, el), { maxlength: "40", placeholder: "언제 (예: 매월 25일)", "aria-label": `${w.name} 월급 받는 때` }),
        setIn(room, sal.from || "", (x, v, el) => setSalary("from", v, el), { maxlength: "60", placeholder: "주는 곳", "aria-label": `${w.name} 월급 주는 곳` })));
    }
    const sg = state.salary && state.salary.roomId === room.id ? state.salary : null;
    if (!sg) {
      box.append(h("div", { class: "jmn-actions" }, btn("월급 추측하기 (AI 1번)", () => void startSalaryGuess(room), { ghost: true, disabled: !!state.busy })),
        hint("캐릭터 카드 · 페르소나를 읽고 비어 있는 월급 칸만 채워요(로어북은 읽지 않아요). 부르기 전에 예상 토큰을 보여 드려요."));
    } else if (sg.phase === "gathering") box.append(empty("캐릭터 카드를 읽는 중이에요…"));
    else if (sg.phase === "confirm") {
      box.append(h("div", { class: "jmn-form" },
        h("b", { text: `예상 입력 토큰: 약 ${fmt(sg.tokens)}` }),
        hint(`답은 최대 ${fmt(SALARY_TOKENS)} 토큰이에요. AI를 한 번 불러요. 비어 있는 월급 칸만 채워요.`),
        aiUse(),
        h("div", { class: "jmn-actions" }, btn("AI에게 보내기", () => void runSalaryGuess(room)), btn("취소", () => { state.salary = null; render(); }, { ghost: true }))));
    } else if (sg.phase === "calling") box.append(empty("AI가 월급을 추측하는 중이에요…"));
    else {
      box.append(h("p", { class: "jmn-error", text: sg.error || "문제가 생겼어요." }),
        h("div", { class: "jmn-actions" },
          sg.user ? btn("다시 시도", () => { sg.phase = "confirm"; render(); }) : btn("다시 읽기", () => void startSalaryGuess(room)),
          btn("취소", () => { state.salary = null; render(); }, { ghost: true })));
    }

    box.append(section("가게와 품목", `${d.pack.shops.length}곳`));
    for (const s of d.pack.shops) {
      const openEd = state.editShopId === s.id;
      box.append(row(s.name, [s.kind === "delivery" ? "배달" : "상점", `품목 ${s.items.length}개`].join(" · "),
        btn(openEd ? "접기" : "고치기", () => { state.editShopId = openEd ? "" : s.id; render(); }, { ghost: true }),
        btn("삭제", () => edit(room, (x) => { x.pack.shops = x.pack.shops.filter((y) => y.id !== s.id); if (state.shopId === s.id) state.shopId = ""; }, `${s.name}을(를) 지웠어요.`), { ghost: true, danger: true, label: `${s.name} 삭제` })));
      if (!openEd) continue;
      const kind = h("select", { class: "jmn-in", onchange: (e) => quietEdit(room, () => { s.kind = e.target.value === "delivery" ? "delivery" : "shop"; }) },
        h("option", { value: "shop", text: "상점 (바로 가방으로)" }), h("option", { value: "delivery", text: "배달 (두 턴 뒤 도착)" }));
      kind.value = s.kind;
      const ed = h("div", { class: "jmn-form" },
        h("div", { class: "jmn-form-grid" },
          field("가게 이름", setIn(room, s.name, (x, v, el) => { s.name = str(v, 60) || s.name; el.value = s.name; }, { maxlength: "60" })),
          field("종류", kind)),
        field("한 줄 설명", setIn(room, s.desc, (x, v) => { s.desc = str(v, 120); }, { maxlength: "120" })));
      for (const it of s.items) {
        ed.append(h("div", { class: "jmn-item-edit" },
          setIn(room, it.name, (x, v, el) => { it.name = str(v, 60) || it.name; el.value = it.name; }, { maxlength: "60", "aria-label": "품목 이름" }),
          setIn(room, String(it.price), (x, v, el) => { it.price = num(v); el.value = String(it.price); }, { inputmode: "numeric", "aria-label": "가격", class: "jmn-in jmn-in-price" }),
          setIn(room, it.stock == null ? "" : String(it.stock), (x, v, el) => { setStock(it, parseStock(v, null)); el.value = it.stock == null ? "" : String(it.stock); }, { inputmode: "numeric", placeholder: "무제한", "aria-label": "재고 (비우면 무제한)", title: "재고 (비우면 무제한)", class: "jmn-in jmn-in-stock" }),
          btn("✕", () => edit(room, () => { s.items = s.items.filter((y) => y.id !== it.id); }), { ghost: true, danger: true, label: `${it.name} 삭제` })));
      }
      ed.append(h("form", { class: "jmn-item-edit", onsubmit: (e) => {
        e.preventDefault();
        const name = str(dget("s.item"), 60);
        if (!name) return fail("품목 이름을 적어 주세요.");
        if (s.items.length >= CAP.items) return fail(`품목은 가게마다 ${CAP.items}개까지 둘 수 있어요.`);
        const price = num(dget("s.price"));
        const stock = parseStock(dget("s.stock"), null);
        delete draft["s.item"]; delete draft["s.price"]; delete draft["s.stock"];
        edit(room, () => { const it = { id: uid(), name, price, stock: null }; setStock(it, stock); s.items.push(it); }, `${name}을(를) 추가했어요.`);
      } },
      inp("s.item", { maxlength: "60", placeholder: "새 품목 이름", "aria-label": "새 품목 이름" }),
      inp("s.price", { inputmode: "numeric", placeholder: "가격", "aria-label": "새 품목 가격", class: "jmn-in jmn-in-price" }),
      inp("s.stock", { inputmode: "numeric", placeholder: "재고", "aria-label": "새 품목 재고 (비우면 무제한)", title: "재고 (비우면 무제한)", class: "jmn-in jmn-in-stock" }),
      btn("추가", null, { submit: true })));
      box.append(ed);
    }
    box.append(h("form", { class: "jmn-item-edit", onsubmit: (e) => {
      e.preventDefault();
      const name = str(dget("s.shop"), 60);
      if (!name) return fail("가게 이름을 적어 주세요.");
      if (d.pack.shops.length >= CAP.shops) return fail(`가게는 ${CAP.shops}곳까지 둘 수 있어요.`);
      const shop = { id: uid(), name, kind: dget("s.kind", "shop") === "delivery" ? "delivery" : "shop", desc: "", items: [], soldOutHistory: [] };
      delete draft["s.shop"];
      state.editShopId = shop.id;
      edit(room, (x) => { x.pack.shops.push(shop); }, `${name}을(를) 추가했어요. 품목을 넣어 보세요.`);
    } },
    inp("s.shop", { maxlength: "60", placeholder: "새 가게 이름", "aria-label": "새 가게 이름" }),
    sel("s.kind", [["shop", "상점"], ["delivery", "배달"]], "shop"),
    btn("가게 추가", null, { submit: true })));

    box.append(section("메시지"), hint(MSG_NOTE));

    box.append(section("AI"));
    // 설정 탭을 처음 열 때 한 번만 목록을 불러온다(보기 전용 방에서는 부르지 않는다).
    if (!ai.tried && room.id === state.activeId) void loadConns();
    box.append(aiPicker(false));

    box.append(section("세계관"));
    if (state.confirm === "reread") {
      box.append(h("div", { class: "jmn-form" },
        h("b", { text: "세계관을 다시 읽을까요?" }),
        hint("로어북 · 캐릭터 카드 · 페르소나를 다시 읽고, 예상 토큰을 보여 준 뒤 AI를 한 번 불러요. 화폐 · 가게 · 새 임무가 새 초안으로 바뀌어요."),
        h("div", { class: "jmn-swrow jmn-swrow-plain" },
          h("div", { class: "jmn-row-main" }, h("span", { class: "jmn-row-title", text: "지갑 · 가방 · 내역 · 진행 중인 임무도 처음부터 다시 만들기" })),
          switchEl("reset", "지갑 · 가방 · 내역 · 진행 중인 임무도 처음부터 다시 만들기", !!dget("r.reset", false), () => { draft["r.reset"] = !dget("r.reset", false); render(); })),
        h("div", { class: "jmn-actions" },
          btn("다시 읽기", () => { const reset = !!dget("r.reset", false); delete draft["r.reset"]; room.lore = null; room.people = null; void startGather(room, { rerun: true, reset }); }, { disabled: !!state.busy }),
          btn("취소", () => { state.confirm = null; render(); }, { ghost: true }))));
    } else box.append(h("div", { class: "jmn-actions" }, btn("세계관 다시 읽기", () => { state.confirm = "reread"; render(); }, { ghost: true, disabled: !!state.busy })));

    box.append(section("데이터"));
    if (state.confirm === "wipe") {
      box.append(h("div", { class: "jmn-form" },
        h("b", { text: "이 방의 주머니 데이터를 모두 지울까요?" }),
        hint("지갑 · 가방 · 내역 · 임무 · 가게와 RP에 보낸 숨김 메시지가 지워져요. 되돌릴 수 없어요."),
        h("div", { class: "jmn-actions" },
          btn(state.busy === "wipe" ? "지우는 중…" : "지우기", () => wipeRoom(room), { danger: true, disabled: !!state.busy }),
          btn("취소", () => { state.confirm = null; render(); }, { ghost: true }))));
    } else box.append(h("div", { class: "jmn-actions" }, btn("이 방 데이터 지우기", () => { state.confirm = "wipe"; render(); }, { ghost: true, danger: true, disabled: !!state.busy })));
    return box;
  }

  // ── 열기 · 닫기 · 방 고르기 ──
  function resetView() {
    state.menuOpen = false; state.wact = null; state.buy = null; state.shopId = ""; state.questForm = false; state.editShopId = ""; state.confirm = null;
    // AI를 부르는 중이면 창을 닫아도 결과를 버리지 않는다.
    if (!(state.setup && state.setup.phase === "calling")) state.setup = null;
    if (!(state.salary && state.salary.phase === "calling")) state.salary = null;
    const msgDraft = draft["m.text"];
    draft = {};
    if (msgDraft) draft["m.text"] = msgDraft;
  }
  async function setOpen(open) {
    state.open = open;
    resetView();
    // 비밀 탭: 페르소나 목록은 기억하고, 고른 페르소나 · 비밀은 다음에 탭을 열 때 다시 읽는다(다른 곳에서 고쳤을 수 있다).
    if (!open && !sec.busy && !sec.loading) { sec.loadedFor = null; sec.picked = false; sec.autoFrom = null; secResetView(); }
    if (!open) {
      state.chatList = null; setStatus(""); for (const r of state.rooms.values()) flushNow(r);
      // 메시지: 콘보 목록은 다음에 탭을 열 때 다시 읽는다(보내는 중이면 스트림은 계속 받는다).
      msg.listStale = true; msg.picking = false; msg.confirmConnect = false;
      render(); updateFab(); return;
    }
    setStatus("");
    state.activeId = readActiveId();
    state.viewId = state.activeId;
    // 버튼이 깜빡이는 중이면(지금 방에 완료 제안이 있으면) 바로 퀘스트 탭으로.
    if (alertFor(state.activeId)) state.tab = "quest";
    // 새 콘보 메시지 점만 있으면 메시지 탭으로.
    else if (msgTotal() > 0) state.tab = "msg";
    if (state.tab === "msg") msg.fresh = true;
    updateFab();
    render();
    // 창을 열 때 지금 방을 한 번 읽는다.
    if (state.viewId) await selectRoom(state.viewId);
    // 놓친 답장이 있으면 맞춘다(지금 방 · 할 일이 남은 방만, 최근 메시지 GET 1번).
    if (state.open && state.viewId && state.viewId === state.activeId) {
      await reconcileActive("open");
      // 콘보 다리: 연결된 콘보의 최근 문자(4초에 1번까지, GET 1번).
      void bridgeActive("open");
    }
    // 창이 닫혀 있는 동안 반영한 돈 흐름 안내를 한 번 보여 주고 버튼의 금빛 점을 끈다.
    const r = state.rooms.get(state.viewId);
    if (r?.moneyNote && state.open) { if (!state.status) setStatus(r.moneyNote); r.moneyNote = ""; updateFab(); render(); }
  }
  async function toggleMenu() {
    state.menuOpen = !state.menuOpen;
    render();
    if (!state.menuOpen || state.chatList) return;
    state.busy = "list"; render();
    try {
      state.chatList = arr(await api("chats")).filter((c) => c && c.id && isRp(c))
        .map((c) => ({ id: String(c.id), name: c.name, t: Date.parse(c.lastMessageAt || c.updatedAt || "") || 0 }))
        .sort((a, b) => b.t - a.t);
    } catch (e) { setStatus(`방 목록을 불러오지 못했어요: ${e.message || e}`); }
    finally { state.busy = ""; render(); }
  }
  async function selectRoom(id) {
    resetView();
    state.viewId = id;
    state.busy = "room"; render();
    try { await loadRoom(id); } catch (e) { setStatus(`방을 불러오지 못했어요: ${e.message || e}`); }
    finally { state.busy = ""; render(); }
  }

  // ── 버튼 위치 ──
  const vw = () => document.documentElement.clientWidth || window.innerWidth;
  const vh = () => window.innerHeight || document.documentElement.clientHeight;
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi));
  let pos = null;
  function loadPos() {
    try { const p = JSON.parse(localStorage.getItem(POS_KEY) || "null"); if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p; } catch {}
    return null;
  }
  let userPos = null; // 사용자가 끌어다 놓은 위치(이 기기). 없으면 매번 기본 위치(오른쪽 아래)를 다시 계산한다.
  function savePos() { userPos = { x: pos.x, y: pos.y }; try { localStorage.setItem(POS_KEY, JSON.stringify(userPos)); } catch {} }
  function applyPos(dragTo) {
    const base = dragTo || userPos || { x: vw() - 16 - FAB, y: vh() - 160 - FAB };
    pos = { x: clamp(base.x, EDGE, vw() - FAB - EDGE), y: clamp(base.y, EDGE, vh() - FAB - EDGE) };
    fab.style.left = `${pos.x}px`; fab.style.top = `${pos.y}px`;
  }
  function wireFab() {
    let start = null, dragging = false;
    listen(fab, "pointerdown", (e) => {
      if (e.button !== 0) return;
      start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, id: e.pointerId }; dragging = false;
      try { fab.setPointerCapture(e.pointerId); } catch {}
    });
    listen(fab, "pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      dragging = true; fab.classList.add("jmn-dragging");
      applyPos({ x: start.x + dx, y: start.y + dy });
    });
    const end = (e, cancel) => {
      if (!start || e.pointerId !== start.id) return;
      try { fab.releasePointerCapture(e.pointerId); } catch {}
      const wasDrag = dragging;
      start = null; dragging = false; fab.classList.remove("jmn-dragging");
      if (wasDrag) savePos();
      else if (!cancel) void setOpen(!state.open);
    };
    listen(fab, "pointerup", (e) => end(e, false));
    listen(fab, "pointercancel", (e) => end(e, true));
    // 키보드(Enter/Space)로 누른 경우만. 포인터 탭은 pointerup에서 처리한다.
    listen(fab, "click", (e) => { if (e.detail === 0) void setOpen(!state.open); });
  }

  // ── 시작 ──
  function start() {
    document.getElementById(ROOT_ID)?.remove();
    tone = readTone();
    root = h("div", { id: ROOT_ID, class: "jmn-root", "data-tone": tone });
    fab = h("button", { class: "jmn-fab", type: "button", "aria-label": "주머니 열기", title: "주머니" });
    panel = h("div", { class: "jmn-panel", role: "dialog", "aria-label": "주머니", hidden: true });
    root.append(fab, panel);
    document.body.append(root);
    onCleanup(() => root?.remove());
    userPos = loadPos();
    applyPos();
    wireFab();
    updateFab();

    listen(window, "resize", () => applyPos());
    listen(document, "keydown", (e) => {
      if (e.key !== "Escape" || !state.open) return;
      if (state.menuOpen) { state.menuOpen = false; render(); } else void setOpen(false);
    });
    listen(document, "pointerdown", (e) => {
      if (state.open && !root.contains(e.target)) void setOpen(false);
      // 다른 방으로 옮겨 갔을 수 있으니 버튼 알림만 다시 본다(localStorage 읽기만, 네트워크 없음).
      else if (!root.contains(e.target)) timers.set(updateFab, 0);
    }, true);
    listen(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") for (const r of state.rooms.values()) flushNow(r);
      else { updateFab(); void reconcileActive("visible"); void bridgeActive("visible"); }
    });
    // 채팅 입력칸에 처음 입력할 때: 놓친 답장 신호를 다음 메시지를 보내기 전에 맞춘다(숨김 메시지가 제때 바뀌도록).
    listen(document, "keydown", onComposerKey, true);
    listen(document, "input", onComposerKey, true);
    // 다른 탭에서 방을 옮기거나 제안을 정리했을 때.
    listen(window, "storage", (e) => {
      if (!e || e.key == null || e.key === ALERT_KEY || e.key === ACTIVE_KEY) updateFab();
      if (e && e.key === TONE_KEY && readTone() !== tone) { tone = readTone(); root?.setAttribute("data-tone", tone); softRender(); }
    });
    // 엔진 내부 이벤트(문서화 안 됨): 없거나 모양이 바뀌어도 조용히 넘어간다.
    listen(window, "marinara:generation-complete", async (e) => {
      try {
        const id = String(e?.detail?.chatId || "");
        // 메신저가 그 콘보를 보고 있으면 최근 메시지 1번만 다시 읽는다(이 창에서 보낸 답장은 스트림으로 이미 받는다).
        if (id && msgVisible() && msg.selId === id && !msg.picking && !(msg.send && msg.send.chatId === id)) void msgLoadThread(id);
        if (id) await onGenerationComplete(id);
        // 콘보 다리: 지금 RP 방이 읽는 콘보가 답장을 끝냈으면(엔진의 콘보 화면에서 주고받은 것 포함) 그 문자를 읽는다.
        // RP 방 자신의 답장 끝은 콘보를 바꾸지 않으니 읽지 않는다(다음 입력을 시작할 때 맞춘다).
        const act = readActiveId();
        if (id && act && act !== id) {
          const r = state.rooms.get(act);
          if (r ? bridgeConvo(r) === id : readMap(BRIDGE_KEY)[act] === id) void bridgeRun(act, "event");
        }
      } catch (err) { log.warn("[주머니] 생성 완료 처리 실패", err); }
    });
    // 엔진 알림 말풍선이 생기거나 바뀔 때만 새 콘보 메시지를 확인한다(폴링 없음).
    startBubbleWatch();
    onCleanup(() => { for (const r of state.rooms.values()) flushNow(r); });
    onCleanup(() => { try { msg.send?.ctrl?.abort(); } catch {} });
  }

  function cleanup() {
    while (cleanupFns.length) { const fn = cleanupFns.pop(); try { fn(); } catch {} }
  }
  try { if (typeof hostApi.onCleanup === "function") hostApi.onCleanup(cleanup); } catch {}
  if (document.readyState === "loading") listen(document, "DOMContentLoaded", start, { once: true });
  else start();
  void VERSION;
})();
