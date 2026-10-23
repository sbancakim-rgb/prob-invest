/* 확률투자 앱: data/*.json(PC의 파이썬이 매일 만든 결과)을 읽어 보여 준다. */
(function () {
  "use strict";

  const S = { h: "5", view: "picks", more: "rules", ruleFilter: "pass", ruleShow: 30, lab: [], trackSrc: "all", trackShow: 8, open: {} };
  try { S.h = localStorage.getItem("h") || "5"; } catch (e) {}

  let META, CONDS, COMBOS, TODAY;
  let condIdx = {}, condById = {}, comboByKey = {}, memberSet = {}, passing = {};
  const lazy = {};   // prices.json, track.json은 필요할 때 한 번만 받는다

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ── 숫자 표시 ── */
  const pct = (x, d = 1) => (x == null ? "–" : (x * 100).toFixed(d) + "%");
  const spct = (x, d = 2) => (x == null ? "–" : (x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
  const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
  const num = (n) => (n == null ? "–" : n.toLocaleString("ko-KR"));
  const hLabel = { "1": "다음날", "5": "5거래일 뒤", "20": "20거래일 뒤" };
  const hShort = { "1": "1일", "5": "5일", "20": "20일" };
  const mmdd = (d) => `${+d.slice(5, 7)}월 ${+d.slice(8, 10)}일`;

  function won(x) {
    if (x == null) return "–";
    if (x >= 1e12) return (x / 1e12).toFixed(x >= 1e13 ? 0 : 1) + "조";
    if (x >= 1e8) return Math.round(x / 1e8).toLocaleString("ko-KR") + "억";
    if (x >= 1e4) return Math.round(x / 1e4).toLocaleString("ko-KR") + "만";
    return Math.round(x).toLocaleString("ko-KR");
  }
  function shares(x) {
    if (x == null) return "–";
    if (x >= 1e8) return (x / 1e8).toFixed(1) + "억주";
    if (x >= 1e4) return (x / 1e4).toFixed(x >= 1e6 ? 0 : 1) + "만주";
    return Math.round(x).toLocaleString("ko-KR") + "주";
  }

  const GRADE_TXT = {
    A: "학습·검증 두 기간 모두 비용을 빼고도 수익, 검증 기간 상승확률 50% 이상, 우연으로 보기 어려운 수준",
    B: "검증 기간에도 비용 뺀 수익·상승확률 50% 이상이었지만, 우연일 가능성을 배제할 만큼 뚜렷하진 않음",
    X: "학습 기간에서만 좋았고 검증 기간에 기준 미달 → 우연이었거나 효과가 사라졌을 가능성",
    N: "학습 기간부터 기준을 넘지 못했거나 사례가 부족함",
  };
  const badge = (g) => `<span class="badge ${g || "N"}" title="${esc(GRADE_TXT[g || "N"])}">${g || "–"}</span>`;
  const STATUS = { wait: "매수 전", open: "진행 중", done: "완료", skip: "매수 불가" };

  /* pack: [n, 승률, 평균, 중앙값, 초과, t, 우세한해, 전체해] */
  const P = (a) => a && { n: a[0], win: a[1], mean: a[2], med: a[3], ex: a[4], t: a[5], ypos: a[6], yrs: a[7] };

  function keyOf(ids) {
    return ids.slice().sort((a, b) => condIdx[a] - condIdx[b]).join("+");
  }
  function comboStat(ids, h) {
    const c = comboByKey[keyOf(ids)];
    if (!c) return null;
    const [g, tr, te] = c.h[h];
    return { g, tr: P(tr), te: P(te) };
  }
  const pills = (ids) =>
    `<div class="conds">${ids.map((id, i) => (i ? '<span class="cpill amp">+</span>' : "") + `<span class="cpill">${esc(condById[id] ? condById[id].name : id)}</span>`).join("")}</div>`;
  const stockName = (code) => (TODAY.stocks[code] || [code])[0];

  /* 오늘 이 종목이 해당하는 검증 통과 조합(서버와 같은 순서: A 먼저, 검증 초과수익 순) */
  function expect(code, h) {
    const out = [];
    for (const c of passing[h]) if (c.ids.every((id) => memberSet[id].has(code))) out.push(c);
    return out;
  }

  function statTable(st, h) {
    const b = META.base[h];
    const bt = { win: b.train[1], mean: b.train[0] }, be = { win: b.test[1], mean: b.test[0] };
    const tr = st.tr || {}, te = st.te || {};
    const row = (label, f, bf, isRet) =>
      `<tr><td>${label}</td><td class="${isRet ? cls(tr[f]) : ""}">${tr[f] == null ? "–" : isRet ? spct(tr[f]) : pct(tr[f])}</td><td class="base">${bf ? (isRet ? spct(bt[bf]) : pct(bt[bf])) : ""}</td>` +
      `<td class="${isRet ? cls(te[f]) : ""}">${te[f] == null ? "–" : isRet ? spct(te[f]) : pct(te[f])}</td><td class="base">${bf ? (isRet ? spct(be[bf]) : pct(be[bf])) : ""}</td></tr>`;
    return `<table class="cmp"><thead><tr><th></th><th>학습</th><th>기준</th><th>검증</th><th>기준</th></tr></thead><tbody>
      ${row("상승 확률", "win", "win", false)}
      ${row("평균 수익", "mean", "mean", true)}
      ${row("중앙값 수익", "med", null, true)}
      <tr><td>사례 수</td><td>${num(tr.n)}</td><td></td><td>${num(te.n)}</td><td></td></tr>
      <tr><td>기준보다 좋았던 해</td><td>${tr.yrs ? `${tr.ypos}/${tr.yrs}년` : "–"}</td><td></td><td>${te.yrs ? `${te.ypos}/${te.yrs}년` : "–"}</td><td></td></tr>
      <tr><td>신뢰도(t값)</td><td>${tr.t == null ? "–" : tr.t.toFixed(1)}</td><td></td><td>${te.t == null ? "–" : te.t.toFixed(1)}</td><td></td></tr>
    </tbody></table>
    <p class="note">${hLabel[h]} 종가 기준, 다음 날 시가 매수·비용 ${pct(META.cost, 2)} 차감. 학습 ${META.train[0].slice(0, 4)}~${META.train[1].slice(0, 4)}, 검증 ${META.test[0].slice(0, 4)}~. '기준'은 같은 기간 모든 종목·모든 날의 평균.</p>`;
  }

  const quoteHtml = (code) => {
    const q = (TODAY.quote || {})[code];
    if (!q) return "";
    return `<div class="quote"><span><span class="k">시가총액</span><b>${won(q[0])}</b></span><span><span class="k">거래량</span><b>${shares(q[1])}</b></span><span><span class="k">거래대금</span><b>${q[3] ? "" : "약 "}${won(q[2])}</b></span></div>`;
  };
  const riskHtml = (code) => {
    const f = (TODAY.risk || {})[code];
    return f ? `<div class="risk">⚠ ${f.map(esc).join(" · ")}</div>` : "";
  };

  /* ── 데이터 ── */
  const get = (f) => fetch("data/" + f, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
  function need(name) {
    if (!lazy[name]) lazy[name] = get(name + ".json").catch((e) => { delete lazy[name]; throw e; });
    return lazy[name];
  }
  let PR = null, TR = null;   // prices, track
  const prices = () => need("prices").then((p) => (PR = p));
  const track = () => need("track").then((t) => (TR = t));

  /* 시세: 종가 배열(최근 120거래일, prices.json) */
  function series(code, fromDate) {
    if (!PR || !PR.c[code]) return null;
    let i0 = 0;
    if (fromDate) { i0 = PR.dates.indexOf(fromDate); if (i0 < 0) i0 = PR.dates.findIndex((d) => d > fromDate); if (i0 < 0) return null; }
    return { dates: PR.dates.slice(i0), c: PR.c[code].slice(i0) };
  }
  function lastClose(code) {
    const c = PR && PR.c[code];
    if (!c) return null;
    let i = c.length - 1; while (i >= 0 && c[i] == null) i--;
    let j = i - 1; while (j >= 0 && c[j] == null) j--;
    return i < 0 ? null : { price: c[i], chg: j >= 0 ? c[i] / c[j] - 1 : null, date: PR.dates[i] };
  }

  /* ── 차트: 누르거나 마우스를 올리면 날짜·종가·전일대비 ── */
  const CH = {};
  let chartSeq = 0;
  function chart(s, opt = {}) {
    if (!s || s.c.filter((v) => v != null).length < 2) return `<div class="note">시세 데이터가 없습니다.</div>`;
    const id = "ch" + ++chartSeq;
    const W = 320, H = opt.h || 130, pad = 6;
    const vals = s.c.filter((v) => v != null), mn = Math.min(...vals), mx = Math.max(...vals), rg = mx - mn || 1;
    const X = (i) => pad + (i / Math.max(1, s.c.length - 1)) * (W - pad * 2);
    const Y = (v) => pad + (1 - (v - mn) / rg) * (H - pad * 2);
    let d = "", pen = false;
    s.c.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); pen = true; });
    const first = vals[0], last = vals[vals.length - 1];
    const col = last >= first ? "var(--up)" : "var(--down)";
    const marks = (opt.marks || []).map((m) => {
      const i = s.dates.indexOf(m.date);
      if (i < 0) return "";
      return `<line x1="${X(i)}" x2="${X(i)}" y1="0" y2="${H}" class="mk"/><text x="${Math.min(X(i) + 3, W - 40)}" y="11" class="mkt">${esc(m.label)}</text>`;
    }).join("");
    CH[id] = { s, X, Y, W, H };
    return `<div class="chart" id="${id}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
        ${marks}<path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
        <line class="cx" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
      </svg>
      <span class="dot" hidden></span><div class="tip" hidden></div>
      <div class="chart-foot"><span>${esc(s.dates[0].slice(2).replace(/-/g, "."))}</span><span class="note">누르거나 올려 보세요</span><span>${esc(s.dates[s.dates.length - 1].slice(2).replace(/-/g, "."))}</span></div>
    </div>`;
  }
  function bindCharts(root) {
    root.querySelectorAll(".chart").forEach((el) => {
      const cd = CH[el.id];
      if (!cd || el.dataset.bound) return;
      el.dataset.bound = 1;
      const svg = el.querySelector("svg"), cx = el.querySelector(".cx"), tip = el.querySelector(".tip"), dot = el.querySelector(".dot");
      const show = (ev) => {
        const r = svg.getBoundingClientRect();
        const rx = (ev.clientX - r.left) / r.width;
        let i = Math.round(((rx * cd.W - 6) / (cd.W - 12)) * (cd.s.c.length - 1));
        i = Math.max(0, Math.min(cd.s.c.length - 1, i));
        while (i > 0 && cd.s.c[i] == null) i--;
        const v = cd.s.c[i];
        if (v == null) return;
        let j = i - 1; while (j >= 0 && cd.s.c[j] == null) j--;
        const prev = j >= 0 ? cd.s.c[j] : (PR && PR.c ? null : null);
        const chg = prev ? v / prev - 1 : null;
        const px = (cd.X(i) / cd.W) * r.width, py = (cd.Y(v) / cd.H) * r.height;
        cx.setAttribute("x1", cd.X(i)); cx.setAttribute("x2", cd.X(i)); cx.setAttribute("visibility", "visible");
        dot.hidden = false; dot.style.left = px + "px"; dot.style.top = py + "px";
        tip.hidden = false;
        tip.innerHTML = `<b>${esc(cd.s.dates[i])}</b><br>종가 ${num(v)}원<br>전일대비 <span class="${cls(chg)}">${chg == null ? "–" : spct(chg)}</span>`;
        const tw = tip.offsetWidth;
        tip.style.left = Math.max(0, Math.min(r.width - tw, px - tw / 2)) + "px";
      };
      const hide = () => { cx.setAttribute("visibility", "hidden"); tip.hidden = true; dot.hidden = true; };
      el.addEventListener("pointermove", show);
      el.addEventListener("pointerdown", show);
      el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    });
  }
  function spark(s) {
    if (!s) return "";
    const v = s.c.filter((x) => x != null);
    if (v.length < 2) return "";
    const w = 84, hh = 34, mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1;
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(hh - 2 - ((x - mn) / r) * (hh - 4)).toFixed(1)}`).join(" ");
    const c = v[v.length - 1] >= v[0] ? "var(--up)" : "var(--down)";
    return `<svg width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }

  /* ── 관심종목(이 기기에 저장) ── */
  const WK = "watch_v1", SK = "watch_snaps_v1";
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let WATCH = [], SNAPS = {};
  const isWatched = (code) => WATCH.some((w) => w.code === code);
  function addWatch(code) {
    if (isWatched(code)) return;
    const lc = lastClose(code);
    WATCH.unshift({ code, added: TODAY.asof, price: lc ? lc.price : null });
    save(WK, WATCH); snapToday();
  }
  function removeWatch(code) { WATCH = WATCH.filter((w) => w.code !== code); save(WK, WATCH); }
  /* 앱을 열 때마다 관심종목의 '오늘의 예상'을 기기에 기록 → 나중에 실제 결과와 비교 */
  function snapToday() {
    WATCH.forEach((w) => {
      const s = (SNAPS[w.code] = SNAPS[w.code] || {});
      if (s[TODAY.asof]) return;
      const e = {};
      META.horizons.forEach((h) => {
        const m = expect(w.code, String(h));
        if (m.length) { const te = P(m[0].h[h][2]); e[h] = [m[0].h[h][0], te.win, te.mean, m.length]; }
      });
      s[TODAY.asof] = e;
    });
    save(SK, SNAPS);
  }
  /* 예상의 실제 결과: 다음 날 시가 매수 → h거래일 뒤 종가(비용 차감) */
  function outcome(code, date, h) {
    if (!PR || !PR.c[code]) return { status: "nodata" };
    const i = PR.dates.indexOf(date);
    if (i < 0) return { status: "nodata" };
    const T = PR.dates.length;
    if (i + 1 >= T) return { status: "wait" };
    const e = PR.o[code][i + 1];
    if (e == null) return { status: "skip" };
    const last = Math.min(i + +h, T - 1);
    let x = PR.c[code][last], k = last;
    while (x == null && k > i) x = PR.c[code][--k];
    if (x == null) return { status: "nodata" };
    return { status: i + +h <= T - 1 ? "done" : "open", ret: x / e - 1 - META.cost, held: last - i };
  }

  /* ── 오늘의 추천 ── */
  function renderPicks() {
    const v = $("#v-picks");
    const pk = TODAY.picks[S.h];
    const b = META.base[S.h];
    let html = `<div class="card"><div class="note">
      <b>${hLabel[S.h]}</b> 기준으로 검증을 통과한 조합 <b>${num(pk.n_good)}개</b> 중 하나 이상의 조건이 모두 일치하는 종목입니다(${esc(TODAY.asof)} 마감, 상위 ${META.top || 40}개).
      아무 종목이나 샀을 때의 검증 기간 상승 확률은 <b>${pct(b.test[1])}</b>, 평균 <b class="${cls(b.test[0])}">${spct(b.test[0])}</b>입니다.
      실제로 맞았는지는 <a href="#" data-go="track">추천 성과</a>에서 확인하세요.</div></div>`;
    if (!pk.rows.length) html += `<div class="empty">오늘은 검증된 조합에 맞는 종목이 없습니다.<br>조건이 맞지 않는 날엔 쉬는 것도 규칙입니다.</div>`;
    pk.rows.forEach((r) => {
      const s = TODAY.stocks[r.code] || [r.code, "", ""];
      const best = pk.combos[r.combos[0]];
      const st = comboStat(best, S.h);
      const te = st && st.te;
      html += `<div class="card tap" data-code="${r.code}"><div class="stock">
        <div class="nm">${badge(r.g)}<span class="t">${esc(s[0])}</span>${isWatched(r.code) ? '<span class="star">★</span>' : ""}</div>
        <div class="meta">${esc(s[1])} · ${esc(s[2])}</div>
        <span class="spk" data-spark="${r.code}"></span>
        ${quoteHtml(r.code)}
        <div class="why">${pills(best)}
          ${te ? `<div class="nums"><span><span class="k">검증 상승확률</span> <b>${pct(te.win)}</b></span><span><span class="k">평균</span> <b class="${cls(te.mean)}">${spct(te.mean)}</b></span><span class="k">${num(te.n)}건</span></div>` : ""}
          ${r.cnt > 1 ? `<div class="note">이 외에도 검증된 조합 ${r.cnt - 1}개에 함께 해당</div>` : ""}
          ${riskHtml(r.code)}
        </div></div></div>`;
    });
    html += `<p class="note">추천은 과거 통계일 뿐 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 본인에게 있습니다.</p>`;
    v.innerHTML = html;
    v.querySelectorAll("[data-code]").forEach((el) => (el.onclick = () => openStock(el.dataset.code)));
    bindGo(v);
    prices().then(() => v.querySelectorAll("[data-spark]").forEach((el) => (el.innerHTML = spark(series(el.dataset.spark))))).catch(() => {});
  }

  /* ── 종목 상세(어느 화면에서든) ── */
  function openStock(code) {
    const s = TODAY.stocks[code] || [code, "", ""];
    const h = S.h;
    const draw = () => {
      const w = WATCH.find((x) => x.code === code);
      const m = expect(code, h);
      const lc = lastClose(code);
      let html = `<div class="sh-head"><div><h2>${esc(s[0])} <span class="note">${code}</span></h2><div class="note">${esc(s[1])} · ${esc(s[2])}</div></div>
        <button class="wbtn ${w ? "on" : ""}" id="wToggle">${w ? "★ 관심종목" : "☆ 관심종목 추가"}</button></div>`;
      if (lc) html += `<div class="price"><b>${num(lc.price)}원</b> <span class="${cls(lc.chg)}">${spct(lc.chg)}</span> <span class="note">${esc(lc.date)} 종가</span></div>`;
      html += quoteHtml(code) + riskHtml(code);
      const marks = [];
      if (w) marks.push({ date: w.added, label: "관심 등록" });
      html += `<div class="card">${PR ? chart(series(code), { marks, h: 150 }) : '<div class="note">시세 불러오는 중…</div>'}</div>`;
      html += `<div class="sec-title">오늘의 예상 (${hLabel[h]}, ${esc(TODAY.asof)} 마감 기준)</div>`;
      if (!m.length) html += `<div class="card note">오늘은 ${hLabel[h]} 기준으로 검증된 조합에 해당하지 않습니다. 이 종목에 대한 통계적 우위가 없다는 뜻입니다.</div>`;
      m.slice(0, 5).forEach((c) => {
        const st = comboStat(c.ids, h);
        html += `<div class="card"><div style="display:flex;gap:6px;align-items:flex-start">${badge(st && st.g)}<div style="flex:1">${pills(c.ids)}</div></div>${st ? statTable(st, h) : ""}</div>`;
      });
      if (m.length > 5) html += `<div class="note">이 외에도 검증된 조합 ${m.length - 5}개에 해당</div>`;
      html += `<div class="sec-title">지난 예상과 실제 결과</div>` + historyHtml(code);
      html += `<a class="more" style="display:block;text-align:center;text-decoration:none" href="https://finance.naver.com/item/main.naver?code=${code}" target="_blank" rel="noopener">네이버 금융에서 보기 ↗</a>`;
      openSheet(html);
      $("#wToggle").onclick = () => { isWatched(code) ? removeWatch(code) : addWatch(code); draw(); if (S.view === "watch") renderWatch(); };
    };
    draw();
    Promise.all([prices(), track()]).then(() => { if (!$("#sheet").hidden) draw(); }).catch(() => {});
  }

  /* 이 종목의 예상 기록(추천 기록 + 관심종목 기록) → 결과 */
  function historyHtml(code) {
    if (!TR || !PR) return `<div class="card note">불러오는 중…</div>`;
    const items = {};
    TR.rows.filter((r) => r[2] === code).forEach((r) => {
      items[r[0] + "|" + r[1]] = { d: r[0], h: String(r[1]), g: r[3], w: r[4], m: r[5], src: r[7] ? "추천(사후 계산)" : `추천 ${r[8]}위`, ret: r[11], status: r[12] };
    });
    Object.entries(SNAPS[code] || {}).forEach(([d, e]) => Object.entries(e).forEach(([h, x]) => {
      const k = d + "|" + h;
      if (items[k]) return;
      const o = outcome(code, d, h);
      items[k] = { d, h, g: x[0], w: x[1], m: x[2], src: "관심종목", ret: o.ret, status: o.status };
    }));
    const list = Object.values(items).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : +a.h - +b.h));
    if (!list.length) return `<div class="card note">아직 이 종목에 대한 예상 기록이 없습니다. 추천에 오르거나, 관심종목으로 등록한 뒤 검증된 조합에 해당하는 날부터 쌓입니다.</div>`;
    return `<div class="card"><table class="cmp hist"><thead><tr><th>날짜</th><th>기간</th><th>예상</th><th>실제</th></tr></thead><tbody>${list.slice(0, 30).map((x) =>
      `<tr><td>${mmdd(x.d)}<div class="note">${esc(x.src)}</div></td><td>${hShort[x.h]}</td><td>${badge(x.g)} ${pct(x.w, 0)}<div class="note">평균 ${spct(x.m, 1)}</div></td>
       <td class="${cls(x.ret)}">${x.ret == null ? "–" : spct(x.ret, 1)}<div class="note">${STATUS[x.status] || "–"}</div></td></tr>`).join("")}</tbody></table>
      <p class="note">예상 = 해당 조합의 검증 기간 상승확률·평균수익. 실제 = 다음 날 시가 매수 → 기간 끝 종가(진행 중이면 최근 종가), 비용 ${pct(META.cost, 2)} 차감.</p></div>`;
  }

  /* ── 추천 성과 ── */
  function renderTrack() {
    const v = $("#v-track");
    if (!TR || !PR) { v.innerHTML = `<div class="empty">추천 기록 불러오는 중…</div>`; Promise.all([track(), prices()]).then(renderTrack).catch(() => (v.innerHTML = `<div class="empty">추천 기록을 불러오지 못했습니다.</div>`)); return; }
    const h = +S.h;
    let rows = TR.rows.filter((r) => r[1] === h);
    const real = rows.filter((r) => !r[7]), back = rows.filter((r) => r[7]);
    const summ = (rs, label, note) => {
      const done = rs.filter((r) => r.length && r[12] === "done");
      const open = rs.filter((r) => r[12] === "open");
      if (!rs.length) return `<tr><td>${label}<div class="note">${note}</div></td><td colspan="4" class="note" style="text-align:left">아직 기록 없음</td></tr>`;
      const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
      const aw = done.length ? done.filter((r) => r[11] > 0).length / done.length : null;
      return `<tr><td>${label}<div class="note">${note}</div></td><td>${num(done.length)}<div class="note">진행 ${num(open.length)}</div></td>
        <td>${pct(aw)}<div class="note">예상 ${pct(avg(done.map((r) => r[4])))}</div></td>
        <td class="${cls(avg(done.map((r) => r[11])))}">${spct(avg(done.map((r) => r[11])))}<div class="note">예상 ${spct(avg(done.map((r) => r[5])))}</div></td></tr>`;
    };
    let html = `<div class="card"><h3 class="ct">${hLabel[S.h]} 추천의 실제 성과</h3>
      <table class="cmp"><thead><tr><th></th><th>완료</th><th>실제 상승확률</th><th>실제 평균</th></tr></thead><tbody>
      ${summ(real, "실제 추천", "앱이 그날 고른 종목")}
      ${summ(back, "사후 계산", `앱 도입 전 ${back.length ? "기간" : ""}`)}
      </tbody></table>
      <p class="note">'사후 계산'은 지금의 규칙을 앱 도입 전 날짜에 적용해 본 결과입니다(그 규칙은 그 뒤 데이터로 검증된 것이라 실제보다 유리할 수 있음). 날짜마다 상위 ${META.top || 40}종목, 다음 날 시가 매수 → ${hLabel[S.h]} 종가 매도, 비용 차감.</p></div>`;
    html += `<div class="filters">${[["all", "전체"], ["real", "실제 추천"], ["back", "사후 계산"]].map(([k, l]) => `<button class="fbtn ${S.trackSrc === k ? "on" : ""}" data-src="${k}">${l}</button>`).join("")}</div>`;
    if (S.trackSrc === "real") rows = real; else if (S.trackSrc === "back") rows = back;
    const byDate = {};
    rows.forEach((r) => (byDate[r[0]] = byDate[r[0]] || []).push(r));
    const days = Object.keys(byDate).sort().reverse();
    if (!days.length) html += `<div class="empty">기록이 없습니다.</div>`;
    days.slice(0, S.trackShow).forEach((d) => {
      const rs = byDate[d].sort((a, b) => a[8] - b[8]);
      const got = rs.filter((r) => r[11] != null);
      const avg = got.length ? got.reduce((s, r) => s + r[11], 0) / got.length : null;
      const up = got.filter((r) => r[11] > 0).length;
      const st = rs.some((r) => r[12] === "open") ? "진행 중" : rs.every((r) => r[12] === "wait") ? "매수 전" : "완료";
      const key = d + h, isOpen = S.open[key];
      html += `<div class="card day"><button class="day-h" data-day="${key}">
        <span><b>${mmdd(d)}</b> 추천 <span class="note">${rs.length}종목 · ${st}${rs[0][7] ? " · 사후 계산" : ""}</span></span>
        <span class="${cls(avg)}">${avg == null ? "–" : spct(avg)}<span class="note"> ${got.length ? `상승 ${up}/${got.length}` : ""}</span> ${isOpen ? "▲" : "▼"}</span></button>`;
      if (isOpen) {
        html += `<div class="day-list">${rs.map((r) => {
          const s = series(r[2], r[0]);
          return `<div class="trow" data-code="${r[2]}"><span class="rk">${r[8]}</span><span class="tn"><b>${esc(stockName(r[2]))}</b><span class="note">${badge(r[3])} 예상 ${pct(r[4], 0)} · ${spct(r[5], 1)}</span></span>
            <span class="tsp">${spark(s)}</span><span class="tr ${cls(r[11])}">${r[11] == null ? "–" : spct(r[11], 1)}<span class="note">${STATUS[r[12]]}${r[12] === "open" ? ` ${r[13]}일째` : ""}</span></span></div>`;
        }).join("")}<p class="note">작은 그래프 = 추천일부터 현재까지 종가 추이</p></div>`;
      }
      html += `</div>`;
    });
    if (days.length > S.trackShow) html += `<button class="more" id="moreDays">이전 날짜 더 보기 (${days.length - S.trackShow}일)</button>`;
    v.innerHTML = html;
    v.querySelectorAll("[data-src]").forEach((b) => (b.onclick = () => { S.trackSrc = b.dataset.src; S.trackShow = 8; renderTrack(); }));
    v.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => { S.open[b.dataset.day] = !S.open[b.dataset.day]; const y = scrollY; renderTrack(); scrollTo(0, y); }));
    v.querySelectorAll(".trow[data-code]").forEach((el) => (el.onclick = () => openStock(el.dataset.code)));
    const md = $("#moreDays"); if (md) md.onclick = () => { S.trackShow += 8; renderTrack(); };
  }

  /* ── 관심종목 ── */
  function renderWatch() {
    const v = $("#v-watch");
    if (!PR || !TR) { v.innerHTML = `<div class="empty">시세 불러오는 중…</div>`; Promise.all([prices(), track()]).then(renderWatch).catch(() => (v.innerHTML = `<div class="empty">시세를 불러오지 못했습니다.</div>`)); return; }
    let html = `<div class="card"><div class="search"><input id="wq" type="search" placeholder="종목명 또는 코드로 검색해 추가" autocomplete="off"></div><div id="wres"></div>
      <p class="note">관심종목은 이 기기(브라우저)에만 저장됩니다. 앱을 열 때마다 그날의 예상이 기록되고, 이후 실제 결과와 비교됩니다.</p></div>`;
    if (!WATCH.length) html += `<div class="empty">아직 관심종목이 없습니다.<br>위에서 검색하거나, 종목 상세 화면의 ☆ 버튼으로 추가하세요.</div>`;
    WATCH.forEach((w) => {
      const s = TODAY.stocks[w.code] || [w.code, "", ""];
      const lc = lastClose(w.code);
      const since = lc && w.price ? lc.price / w.price - 1 : null;
      const m = expect(w.code, S.h);
      const te = m.length ? P(m[0].h[S.h][2]) : null;
      html += `<div class="card wcard"><div class="wtop" data-code="${w.code}">
        <div><div class="nm"><span class="t">${esc(s[0])}</span> <span class="note">${w.code}</span></div>
        <div class="note">${esc(s[1])} · ${mmdd(w.added)} 등록${w.price ? ` (${num(w.price)}원)` : ""}</div></div>
        <div style="text-align:right">${lc ? `<b>${num(lc.price)}원</b><div class="${cls(lc.chg)}">${spct(lc.chg)}</div>` : "–"}</div></div>
        ${chart(series(w.code), { marks: [{ date: w.added, label: "등록" }], h: 110 })}
        <div class="wgrid">
          <span><span class="k">등록 후 수익률</span><b class="${cls(since)}">${spct(since)}</b></span>
          <span><span class="k">오늘의 예상(${hShort[S.h]})</span>${te ? `<b>${badge(m[0].h[S.h][0])} ${pct(te.win, 0)} · <span class="${cls(te.mean)}">${spct(te.mean, 1)}</span></b>` : `<b class="note">해당 조합 없음</b>`}</span>
        </div>
        ${riskHtml(w.code)}
        <div class="wact"><button class="fbtn" data-detail="${w.code}">예상·결과 자세히</button><button class="fbtn" data-rm="${w.code}">삭제</button></div></div>`;
    });
    v.innerHTML = html;
    bindCharts(v);
    const q = $("#wq"), res = $("#wres");
    q.oninput = () => {
      const t = q.value.trim().toLowerCase();
      if (!t) { res.innerHTML = ""; return; }
      const hits = Object.entries(TODAY.stocks).filter(([c, s]) => PR.c[c] && (c.includes(t) || s[0].toLowerCase().includes(t))).slice(0, 8);
      res.innerHTML = hits.length ? hits.map(([c, s]) => `<button class="hit" data-add="${c}"><span><b>${esc(s[0])}</b> <span class="note">${c} · ${esc(s[1])}</span></span><span>${isWatched(c) ? "★" : "＋ 추가"}</span></button>`).join("") : `<div class="note" style="padding:8px 0">검색 결과가 없습니다(현재 거래 중인 종목만).</div>`;
      res.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => { addWatch(b.dataset.add); renderWatch(); }));
    };
    v.querySelectorAll("[data-detail]").forEach((b) => (b.onclick = () => openStock(b.dataset.detail)));
    v.querySelectorAll(".wtop[data-code]").forEach((b) => (b.onclick = () => openStock(b.dataset.code)));
    v.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { if (confirm(`${stockName(b.dataset.rm)}을(를) 관심종목에서 뺄까요?`)) { removeWatch(b.dataset.rm); renderWatch(); } }));
  }

  /* ── 규칙 순위 ── */
  function renderRules(v) {
    const h = S.h;
    let list = COMBOS.map((c) => ({ ids: c.ids, g: c.h[h][0], tr: P(c.h[h][1]), te: P(c.h[h][2]) }));
    if (S.ruleFilter === "pass") list = list.filter((c) => c.g === "A" || c.g === "B");
    else if (S.ruleFilter === "fail") list = list.filter((c) => c.g === "X");
    else list = list.filter((c) => c.ids.length === 1);
    const key = S.ruleFilter === "fail" ? (c) => -(c.tr ? c.tr.ex : 0) : (c) => -(c.te ? c.te.ex : -9);
    list.sort((a, b) => (S.ruleFilter === "pass" ? (a.g > b.g) - (a.g < b.g) : 0) || key(a) - key(b));
    const desc = {
      pass: `학습 기간에서 찾고, 한 번도 안 본 검증 기간에서도 비용을 빼고 수익을 낸 조합입니다. A가 더 확실합니다.`,
      fail: `학습 기간에는 성적이 좋았지만 검증 기간에 무너진 조합입니다. 과거 데이터만 보고 규칙을 믿으면 안 되는 이유를 보여 줍니다.`,
      single: `조건 하나씩의 성적입니다. 평소 알려진 '규칙'이 실제로 통하는지 확인해 보세요.`,
    }[S.ruleFilter];
    let html = `<div class="filters">
      <button class="fbtn ${S.ruleFilter === "pass" ? "on" : ""}" data-f="pass">검증 통과</button>
      <button class="fbtn ${S.ruleFilter === "fail" ? "on" : ""}" data-f="fail">검증에서 탈락</button>
      <button class="fbtn ${S.ruleFilter === "single" ? "on" : ""}" data-f="single">단일 조건 전체</button></div>
      <div class="note">${desc} (${hLabel[h]} 기준 ${num(list.length)}개, 검증 기간 평균 초과수익 순)</div>`;
    list.slice(0, S.ruleShow).forEach((c) => {
      const te = c.te, tr = c.tr;
      html += `<div class="card tap" data-k="${esc(c.ids.join("+"))}"><div style="display:flex;gap:6px;align-items:flex-start">${badge(c.g)}<div style="flex:1;min-width:0">${pills(c.ids)}
        <div class="nums"><span>학습 <b>${pct(tr && tr.win)}</b> <span class="${cls(tr && tr.mean)}">${spct(tr && tr.mean)}</span></span>
        <span>검증 <b>${pct(te && te.win)}</b> <span class="${cls(te && te.mean)}">${spct(te && te.mean)}</span></span>
        <span class="note">${num(te && te.n)}건 · 오늘 ${todayMatch(c.ids).length}종목</span></div></div></div></div>`;
    });
    if (list.length > S.ruleShow) html += `<button class="more" id="moreRules">더 보기 (${num(list.length - S.ruleShow)}개 남음)</button>`;
    if (!list.length) html += `<div class="empty">해당하는 조합이 없습니다.</div>`;
    v.innerHTML = html;
    v.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { S.ruleFilter = b.dataset.f; S.ruleShow = 30; renderMore(); }));
    v.querySelectorAll("[data-k]").forEach((el) => (el.onclick = () => openCombo(el.dataset.k.split("+"))));
    const m = $("#moreRules"); if (m) m.onclick = () => { S.ruleShow += 30; renderMore(); };
  }

  function todayMatch(ids) {
    let set = null;
    ids.forEach((id) => { const arr = TODAY.members[id] || []; set = new Set(set ? arr.filter((c) => set.has(c)) : arr); });
    return set ? [...set] : [];
  }

  function stockList(codes, limit = 60) {
    if (!codes.length) return `<div class="empty">오늘 이 조건을 모두 만족하는 종목이 없습니다.</div>`;
    return `<div class="card">${codes.slice(0, limit).map((c) => {
      const s = TODAY.stocks[c] || [c, "", ""];
      return `<button class="hit" data-open="${c}"><span><b>${esc(s[0])}</b> <span class="note">${c}</span></span><span class="note">${esc(s[1])}</span></button>`;
    }).join("")}${codes.length > limit ? `<div class="note" style="padding-top:8px">외 ${codes.length - limit}종목</div>` : ""}</div>`;
  }
  function bindOpen(root) { root.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openStock(b.dataset.open))); }

  function openCombo(ids) {
    const st = comboStat(ids, S.h);
    let html = `<h2>조합 상세</h2>${pills(ids)}`;
    html += st ? `<div class="card"><div class="note" style="margin-bottom:4px">${badge(st.g)} ${esc(GRADE_TXT[st.g || "N"])}</div>${statTable(st, S.h)}</div>`
               : `<div class="card note">이 조합의 과거 성적은 저장되어 있지 않습니다.</div>`;
    const m = todayMatch(ids);
    html += `<div class="sec-title">오늘 해당 종목 ${m.length}개</div>` + stockList(m);
    openSheet(html);
    bindOpen($("#sheetBody"));
  }

  /* ── 조건 실험실 ── */
  function renderLab() {
    const v = $("#v-lab");
    const sel = S.lab;
    const cur = sel.length ? todayMatch(sel) : null;
    const curSet = cur && new Set(cur);
    let html = `<div class="card"><div class="note">원하는 규칙·상태를 골라 보세요(최대 4개). <b>모두 일치하는 오늘의 종목</b>과 그 조합의 <b>과거 성적</b>을 보여 줍니다.</div></div>`;
    if (sel.length) {
      const st = sel.length <= 3 ? comboStat(sel, S.h) : null;
      html += `<div class="card">${pills(sel)}`;
      if (st) html += `<div class="note" style="margin:4px 0">${badge(st.g)} ${esc(GRADE_TXT[st.g || "N"])}</div>${statTable(st, S.h)}`;
      else html += `<div class="note">${sel.length <= 2
          ? "학습 기간 사례가 300건 미만이라 통계를 내지 않았습니다. 조건을 줄여 보세요."
          : "이 조합의 과거 성적은 앱에 저장되어 있지 않습니다(3개 이상 조합은 검증 등급이 붙은 것만 저장). 표본이 적거나 학습 기간 성적이 기준에 못 미쳤다는 뜻입니다."}</div>`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><b>오늘 일치 ${cur.length}종목</b><button class="fbtn" id="labReset">초기화</button></div></div>`;
      html += stockList(cur, 40);
      html += `<button class="labbar" id="labTop">선택 ${sel.length}개 · 오늘 일치 <b>${cur.length}종목</b> · 결과 보기 ↑</button>`;
    }
    const groups = {};
    CONDS.forEach((c) => (groups[c.group] = groups[c.group] || []).push(c));
    Object.entries(groups).forEach(([g, list]) => {
      html += `<div class="grp"><h3>${esc(g)}${list[0].excl ? " <span class='note'>(하나만 선택)</span>" : ""}</h3><div class="chips">`;
      list.forEach((c) => {
        const on = sel.includes(c.id);
        const mem = TODAY.members[c.id] || [];
        const cnt = curSet && !on ? mem.filter((x) => curSet.has(x)).length : mem.length;
        const label = c.group === "업종" ? c.name.replace("업종: ", "") : c.name;
        html += `<button class="chip ${on ? "on" : ""}" data-c="${c.id}" ${!on && sel.length >= 4 ? "disabled" : ""}>${esc(label)}<span class="cnt">${cnt}</span></button>`;
      });
      html += `</div></div>`;
    });
    html += `<p class="note">칩 옆 숫자 = 지금 선택에 이 조건을 더하면 오늘 남는 종목 수</p>`;
    v.innerHTML = html;
    bindOpen(v);
    v.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.c, c = condById[id];
      if (S.lab.includes(id)) S.lab = S.lab.filter((x) => x !== id);
      else { if (c.excl) S.lab = S.lab.filter((x) => condById[x].group !== c.group); S.lab.push(id); }
      const y = scrollY; renderLab(); scrollTo(0, y);
    }));
    const r = $("#labReset"); if (r) r.onclick = () => { S.lab = []; renderLab(); };
    const tp = $("#labTop"); if (tp) tp.onclick = () => scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ── 더보기: 규칙 순위 · 설명 ── */
  function renderMore() {
    const v = $("#v-more");
    v.innerHTML = `<div class="filters sub">${[["rules", "규칙 순위"], ["help", "설명"]].map(([k, l]) => `<button class="fbtn ${S.more === k ? "on" : ""}" data-more="${k}">${l}</button>`).join("")}</div><div id="moreBody"></div>`;
    v.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => { S.more = b.dataset.more; renderMore(); }));
    S.more === "rules" ? renderRules($("#moreBody")) : renderHelp($("#moreBody"));
  }

  function renderHelp(v) {
    const c = META.criteria;
    const rows = META.horizons.map((h) => `<tr><td>${hLabel[h]}</td><td>${pct(META.base[h].train[1])}</td><td class="${cls(META.base[h].train[0])}">${spct(META.base[h].train[0])}</td><td>${pct(META.base[h].test[1])}</td><td class="${cls(META.base[h].test[0])}">${spct(META.base[h].test[0])}</td></tr>`).join("");
    v.innerHTML = `<div class="help">
      <div class="card install" id="installCard" hidden><span class="note" id="installTxt">홈 화면에 앱으로 설치할 수 있습니다.</span><button id="installBtn" hidden>설치</button></div>
      <div class="card"><h2>어떻게 작동하나요</h2>
        <ul><li>코스피·코스닥 보통주 <b>${num(META.n_stocks)}종목</b>(상장폐지 ${num(META.n_delisted)}종목 포함)의 2015년 이후 일봉을 사용합니다.</li>
        <li>장 마감 후 조건을 판정 → <b>다음 날 시가에 사서</b> 1·5·20거래일 뒤 종가에 판다고 가정합니다. 거래비용 ${pct(META.cost, 2)}를 뺍니다.</li>
        <li>20일 평균 거래대금 ${(META.min_amt / 1e8).toFixed(0)}억 원 미만 종목과 거래정지 종목은 제외합니다.</li>
        <li>조건 하나, 두 개 조합 전부, 세 개 조합 일부까지 시험해 사례가 충분한 <b>${num(META.n_tested)}개</b>를 검증했습니다.</li>
        <li>평일 18:30에 PC가 자동으로 갱신합니다. 조합 검증은 7일마다 다시 합니다.</li></ul></div>
      <div class="card"><h2>왜 '학습'과 '검증'을 나누나요</h2>
        <p>조합을 수천 개 시험하면 의미 없는 조합도 우연히 좋아 보입니다. 그래서 <b>${META.train[0].slice(0, 4)}~${META.train[1].slice(0, 4)}년(학습)</b>에서 좋은 조합을 고른 뒤, 한 번도 안 본 <b>${META.test[0].slice(0, 4)}년~현재(검증)</b>에서 다시 확인합니다.</p>
        <ul><li>${badge("A")} ${GRADE_TXT.A}</li><li>${badge("B")} ${GRADE_TXT.B}</li><li>${badge("X")} ${GRADE_TXT.X}</li></ul>
        <p class="note">통과 기준: ① 학습 기간 사례 ${c.min_n_train}건 이상·서로 다른 달 ${c.min_clusters}개 이상·t값 ${c.t_train} 이상·비용 뺀 평균수익 플러스 ② 검증 기간 사례 ${c.min_n_test}건 이상·비용 뺀 평균수익 플러스·상승확률 50% 이상·상승확률과 평균수익 모두 기준보다 높을 것. A는 검증 t값 ${c.t_test_a} 이상.</p></div>
      <div class="card"><h2>기준선: 아무 종목이나 샀다면</h2>
        <table class="cmp"><thead><tr><th></th><th>학습 상승확률</th><th>평균</th><th>검증 상승확률</th><th>평균</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="note">'상승 확률 55%'는 이 기준과 비교해야 의미가 있습니다. 비용을 빼면 아무 종목이나 산 경우의 상승 확률은 50%보다 낮습니다.</p></div>
      <div class="card"><h2>t값과 '좋았던 해'</h2><p>같은 달 안의 신호들은 서로 닮아서, 사례가 1만 건이어도 실제로는 '몇십 개 달'의 경험일 수 있습니다. 그래서 같은 달의 신호를 하나로 묶어 신뢰도(t값)를 계산했습니다. 보통 2 이상이면 우연일 가능성이 낮다고 봅니다.</p></div>
      <div class="card warn"><h2>꼭 알아 둘 한계</h2>
        <ul><li>과거 통계이며 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 본인에게 있습니다.</li>
        <li>검증 기간 성적은 '수천 개 중 통과한 조합'의 성적이라, 실제 추천 성적은 그보다 낮게 나오는 경향이 있습니다. <a href="#" data-go="track">추천 성과</a>에서 실제 결과를 꼭 확인하세요.</li>
        <li>세금, 큰 금액 매매 시의 가격 충격은 반영하지 않았습니다. 관리종목·투자경고 여부, 수급·재무 데이터도 아직 쓰지 않습니다.</li>
        <li>'오전에 오른다' 같은 장중 규칙은 분 단위 데이터가 필요해 아직 포함하지 않았습니다.</li></ul></div>
      <div class="card"><h2>시험한 규칙·상태 ${CONDS.length}개</h2>${Object.entries(CONDS.reduce((a, c) => ((a[c.group] = a[c.group] || []).push(c), a), {})).map(([g, l]) =>
        `<div class="sec-title">${esc(g)}</div><ul>${l.map((c) => `<li>${esc(c.name.replace("업종: ", ""))}${c.desc ? ` <span class="note">— ${esc(c.desc)}</span>` : ""}</li>`).join("")}</ul>`).join("")}</div>
      <p class="note">데이터 기준일 ${esc(META.asof)} · 추천 계산 ${esc(META.updated)} · 조합 검증 ${esc(META.researched || META.updated)}</p></div>`;
    bindGo(v);
    setupInstall();
  }

  /* ── 설치 안내 ── */
  let deferred = null;
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; setupInstall(); });
  function setupInstall() {
    const card = $("#installCard"); if (!card) return;
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (standalone) { card.hidden = true; return; }
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const btn = $("#installBtn");
    if (deferred) { card.hidden = false; btn.hidden = false; btn.onclick = async () => { deferred.prompt(); deferred = null; card.hidden = true; }; }
    else if (iOS) { card.hidden = false; $("#installTxt").textContent = "앱으로 쓰려면: 사파리 공유 버튼 → 홈 화면에 추가"; }
  }

  /* ── 시트·탭 ── */
  function openSheet(html) {
    const wasOpen = !$("#sheet").hidden, y = $("#sheetBody").scrollTop;
    $("#sheetBody").innerHTML = html;
    $("#sheet").hidden = false; $("#sheetBg").hidden = false;
    $("#sheetBody").scrollTop = wasOpen ? y : 0;
    document.body.style.overflow = "hidden";
    bindCharts($("#sheetBody"));
  }
  function closeSheet() { $("#sheet").hidden = true; $("#sheetBg").hidden = true; document.body.style.overflow = ""; }
  $("#sheetClose").onclick = closeSheet; $("#sheetBg").onclick = closeSheet;
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  function bindGo(root) { root.querySelectorAll("[data-go]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); S.view = a.dataset.go; render(); scrollTo(0, 0); })); }

  const RENDER = { picks: renderPicks, track: renderTrack, watch: renderWatch, lab: renderLab, more: renderMore };
  function render() {
    document.querySelectorAll("#hseg button").forEach((b) => b.classList.toggle("on", b.dataset.h === S.h));
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.view));
    Object.keys(RENDER).forEach((k) => ($("#v-" + k).hidden = k !== S.view));
    $("#hseg").style.visibility = S.view === "more" && S.more === "help" ? "hidden" : "";
    RENDER[S.view]();
  }
  document.querySelectorAll("#hseg button").forEach((b) => (b.onclick = () => {
    S.h = b.dataset.h; try { localStorage.setItem("h", S.h); } catch (e) {}
    render();
  }));
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => { S.view = b.dataset.v; render(); scrollTo(0, 0); }));

  /* ── 시작 ── */
  Promise.all([get("meta.json"), get("conditions.json"), get("combos.json"), get("today.json")])
    .then(([m, c, cb, t]) => {
      META = m; CONDS = c; COMBOS = cb; TODAY = t;
      CONDS.forEach((x, i) => { condIdx[x.id] = i; condById[x.id] = x; memberSet[x.id] = new Set(TODAY.members[x.id] || []); });
      COMBOS.forEach((x) => (comboByKey[keyOf(x.ids)] = x));
      META.horizons.forEach((h) => {
        passing[h] = COMBOS.filter((x) => x.h[h][0] === "A" || x.h[h][0] === "B")
          .sort((a, b) => (a.h[h][0] !== "A") - (b.h[h][0] !== "A") || b.h[h][2][4] - a.h[h][2][4]);
      });
      WATCH = load(WK, []); SNAPS = load(SK, {});
      snapToday();
      $("#asof").textContent = `${META.asof} 마감 기준`;
      render();
    })
    .catch((e) => {
      $("#asof").textContent = "";
      $("#v-picks").innerHTML = `<div class="empty">결과 파일을 불러오지 못했습니다.<br>PC에서 <b>python run.py</b>를 먼저 실행하세요.<br><span class="note">${esc(e.message)}</span></div>`;
    });
})();
