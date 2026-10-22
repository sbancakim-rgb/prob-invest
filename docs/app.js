/* 확률투자 앱: data/*.json(파이썬이 만든 결과)을 읽어 보여 준다. */
(function () {
  "use strict";

  const S = { h: "5", view: "picks", ruleFilter: "pass", ruleShow: 30, lab: [] };
  try { S.h = localStorage.getItem("h") || "5"; } catch (e) {}

  let META, CONDS, COMBOS, TODAY;
  let condIdx = {}, condById = {}, comboByKey = {};

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ── 숫자 표시 ── */
  const pct = (x, d = 1) => (x == null ? "–" : (x * 100).toFixed(d) + "%");
  const spct = (x, d = 2) => (x == null ? "–" : (x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
  const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
  const num = (n) => (n == null ? "–" : n.toLocaleString("ko-KR"));
  const hLabel = { "1": "다음날", "5": "5거래일 뒤", "20": "20거래일 뒤" };

  const GRADE_TXT = {
    A: "학습·검증 두 기간 모두 비용을 빼고도 수익, 검증 기간 상승확률 50% 이상, 우연으로 보기 어려운 수준",
    B: "검증 기간에도 비용 뺀 수익·상승확률 50% 이상이었지만, 우연일 가능성을 배제할 만큼 뚜렷하진 않음",
    X: "학습 기간에서만 좋았고 검증 기간에 기준 미달 → 우연이었거나 효과가 사라졌을 가능성",
    N: "학습 기간부터 기준을 넘지 못했거나 사례가 부족함",
  };
  const badge = (g) => `<span class="badge ${g || "N"}" title="${esc(GRADE_TXT[g || "N"])}">${g || "–"}</span>`;

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

  function spark(arr) {
    if (!arr || arr.length < 2) return "";
    const w = 84, hh = 34, mn = Math.min(...arr), mx = Math.max(...arr), r = mx - mn || 1;
    const pts = arr.map((v, i) => `${((i / (arr.length - 1)) * w).toFixed(1)},${(hh - 2 - ((v - mn) / r) * (hh - 4)).toFixed(1)}`).join(" ");
    const c = arr[arr.length - 1] >= arr[0] ? "var(--up)" : "var(--down)";
    return `<svg width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  const riskHtml = (code) => {
    const f = (TODAY.risk || {})[code];
    return f ? `<div class="risk">⚠ ${f.map(esc).join(" · ")}</div>` : "";
  };

  /* ── 오늘의 추천 ── */
  function renderPicks() {
    const v = $("#v-picks");
    const pk = TODAY.picks[S.h];
    const b = META.base[S.h];
    let html = `<div class="card"><div class="note">
      <b>${hLabel[S.h]}</b> 기준으로 검증을 통과한 조합 <b>${num(pk.n_good)}개</b> 중 하나 이상에 오늘(${esc(TODAY.asof)} 마감) 해당하는 종목 <b>${pk.rows.length}개</b>${pk.rows.length >= 40 ? "(상위 40개만 표시)" : ""}.
      참고로 아무 종목이나 샀을 때의 검증 기간 상승 확률은 <b>${pct(b.test[1])}</b>, 평균 <b class="${cls(b.test[0])}">${spct(b.test[0])}</b>입니다.</div></div>`;
    if (!pk.rows.length) {
      html += `<div class="empty">오늘은 검증된 조합에 맞는 종목이 없습니다.<br>조건이 맞지 않는 날엔 쉬는 것도 규칙입니다.</div>`;
    }
    pk.rows.forEach((r) => {
      const s = TODAY.stocks[r.code] || [r.code, "", ""];
      const best = pk.combos[r.combos[0]];
      const st = comboStat(best, S.h);
      const te = st && st.te;
      html += `<div class="card tap" data-code="${r.code}"><div class="stock">
        <div class="nm">${badge(r.g)}<span class="t">${esc(s[0])}</span></div>
        <div class="meta">${esc(s[1])} · ${esc(s[2])}</div>
        ${spark(TODAY.spark[r.code])}
        <div class="why">${pills(best)}
          ${te ? `<div class="nums"><span><span class="k">검증 상승확률</span> <b>${pct(te.win)}</b></span><span><span class="k">평균</span> <b class="${cls(te.mean)}">${spct(te.mean)}</b></span><span class="k">${num(te.n)}건</span></div>` : ""}
          ${r.cnt > 1 ? `<div class="note">이 외에도 검증된 조합 ${r.cnt - 1}개에 함께 해당</div>` : ""}
          ${riskHtml(r.code)}
        </div></div></div>`;
    });
    html += `<p class="note">추천은 과거 통계일 뿐 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 본인에게 있습니다.</p>`;
    v.innerHTML = html;
    v.querySelectorAll("[data-code]").forEach((el) => (el.onclick = () => openStock(el.dataset.code)));
  }

  function openStock(code) {
    const pk = TODAY.picks[S.h];
    const r = pk.rows.find((x) => x.code === code);
    const s = TODAY.stocks[code] || [code, "", ""];
    let html = `<h2>${esc(s[0])} <span class="note">${code}</span></h2><div class="note">${esc(s[1])} · ${esc(s[2])}</div>`;
    html += riskHtml(code);
    html += `<div class="card">${spark(TODAY.spark[code]).replace('width="84" height="34"', 'width="100%" height="80" preserveAspectRatio="none" style="overflow:visible"')}<div class="note">최근 120거래일 종가</div></div>`;
    html += `<div class="sec-title">해당하는 검증 조합 (${hLabel[S.h]} 기준${r.cnt > 8 ? `, 상위 8개 / 전체 ${r.cnt}개` : ""})</div>`;
    r.combos.forEach((k) => {
      const ids = pk.combos[k];
      const st = comboStat(ids, S.h);
      html += `<div class="card"><div style="display:flex;gap:6px;align-items:flex-start">${badge(st && st.g)}<div style="flex:1">${pills(ids)}</div></div>${st ? statTable(st, S.h) : ""}</div>`;
    });
    html += `<a class="more" style="display:block;text-align:center;text-decoration:none" href="https://finance.naver.com/item/main.naver?code=${code}" target="_blank" rel="noopener">네이버 금융에서 보기 ↗</a>`;
    openSheet(html);
  }

  /* ── 규칙 순위 ── */
  function renderRules() {
    const v = $("#v-rules");
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
    v.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { S.ruleFilter = b.dataset.f; S.ruleShow = 30; renderRules(); }));
    v.querySelectorAll("[data-k]").forEach((el) => (el.onclick = () => openCombo(el.dataset.k.split("+"))));
    const m = $("#moreRules"); if (m) m.onclick = () => { S.ruleShow += 30; renderRules(); };
  }

  function todayMatch(ids) {
    let set = null;
    ids.forEach((id) => {
      const arr = TODAY.members[id] || [];
      set = set ? arr.filter((c) => set.has(c)) : arr;
      set = new Set(set);
    });
    return set ? [...set] : [];
  }

  function stockList(codes, limit = 60) {
    if (!codes.length) return `<div class="empty">오늘 이 조건을 모두 만족하는 종목이 없습니다.</div>`;
    return `<div class="card">${codes.slice(0, limit).map((c) => {
      const s = TODAY.stocks[c] || [c, "", ""];
      return `<a href="https://finance.naver.com/item/main.naver?code=${c}" target="_blank" rel="noopener" style="display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid var(--line);color:inherit;text-decoration:none"><span><b>${esc(s[0])}</b> <span class="note">${c}</span></span><span class="note" style="text-align:right">${esc(s[1])}</span></a>`;
    }).join("")}${codes.length > limit ? `<div class="note" style="padding-top:8px">외 ${codes.length - limit}종목</div>` : ""}</div>`;
  }

  function openCombo(ids) {
    const st = comboStat(ids, S.h);
    let html = `<h2>조합 상세</h2>${pills(ids)}`;
    html += st ? `<div class="card"><div class="note" style="margin-bottom:4px">${badge(st.g)} ${esc(GRADE_TXT[st.g || "N"])}</div>${statTable(st, S.h)}</div>`
               : `<div class="card note">이 조합의 과거 성적은 저장되어 있지 않습니다.</div>`;
    const m = todayMatch(ids);
    html += `<div class="sec-title">오늘 해당 종목 ${m.length}개</div>` + stockList(m);
    openSheet(html);
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
      if (st) {
        html += `<div class="note" style="margin:4px 0">${badge(st.g)} ${esc(GRADE_TXT[st.g || "N"])}</div>${statTable(st, S.h)}`;
      } else {
        html += `<div class="note">${sel.length <= 2
          ? "학습 기간 사례가 300건 미만이라 통계를 내지 않았습니다. 조건을 줄여 보세요."
          : "이 조합의 과거 성적은 앱에 저장되어 있지 않습니다(3개 이상 조합은 검증 등급이 붙은 것만 저장). 표본이 적거나 학습 기간 성적이 기준에 못 미쳤다는 뜻입니다."}</div>`;
      }
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

    v.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.c, c = condById[id];
      if (S.lab.includes(id)) S.lab = S.lab.filter((x) => x !== id);
      else {
        if (c.excl) S.lab = S.lab.filter((x) => condById[x].group !== c.group);
        S.lab.push(id);
      }
      const y = scrollY; renderLab(); scrollTo(0, y);
    }));
    const r = $("#labReset"); if (r) r.onclick = () => { S.lab = []; renderLab(); };
    const tp = $("#labTop"); if (tp) tp.onclick = () => scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ── 설명 ── */
  function renderHelp() {
    const v = $("#v-help");
    const c = META.criteria;
    const rows = META.horizons.map((h) => `<tr><td>${hLabel[h]}</td><td>${pct(META.base[h].train[1])}</td><td class="${cls(META.base[h].train[0])}">${spct(META.base[h].train[0])}</td><td>${pct(META.base[h].test[1])}</td><td class="${cls(META.base[h].test[0])}">${spct(META.base[h].test[0])}</td></tr>`).join("");
    v.innerHTML = `<div class="help">
      <div class="card install" id="installCard" hidden><span class="note" id="installTxt">홈 화면에 앱으로 설치할 수 있습니다.</span><button id="installBtn" hidden>설치</button></div>
      <div class="card"><h2>어떻게 작동하나요</h2>
        <ul><li>코스피·코스닥 보통주 <b>${num(META.n_stocks)}종목</b>(상장폐지 ${num(META.n_delisted)}종목 포함)의 2015년 이후 일봉을 사용합니다.</li>
        <li>장 마감 후 조건을 판정 → <b>다음 날 시가에 사서</b> 1·5·20거래일 뒤 종가에 판다고 가정합니다. 거래비용 ${pct(META.cost, 2)}를 뺍니다.</li>
        <li>20일 평균 거래대금 ${(META.min_amt / 1e8).toFixed(0)}억 원 미만 종목과 거래정지 종목은 제외합니다.</li>
        <li>조건 하나, 두 개 조합 전부, 세 개 조합 일부까지 시험해 사례가 충분한 <b>${num(META.n_tested)}개</b>를 검증했습니다.</li></ul></div>
      <div class="card"><h2>왜 '학습'과 '검증'을 나누나요</h2>
        <p>조합을 수천 개 시험하면 의미 없는 조합도 우연히 좋아 보입니다. 그래서 <b>${META.train[0].slice(0, 4)}~${META.train[1].slice(0, 4)}년(학습)</b>에서 좋은 조합을 고른 뒤, 한 번도 안 본 <b>${META.test[0].slice(0, 4)}년~현재(검증)</b>에서 다시 확인합니다.</p>
        <ul><li>${badge("A")} ${GRADE_TXT.A}</li><li>${badge("B")} ${GRADE_TXT.B}</li><li>${badge("X")} ${GRADE_TXT.X}</li></ul>
        <p class="note">통과 기준: ① 학습 기간 사례 ${c.min_n_train}건 이상·서로 다른 달 ${c.min_clusters}개 이상·t값 ${c.t_train} 이상·비용 뺀 평균수익 플러스 ② 검증 기간 사례 ${c.min_n_test}건 이상·비용 뺀 평균수익 플러스·상승확률 50% 이상·상승확률과 평균수익 모두 기준보다 높을 것. A는 검증 t값 ${c.t_test_a} 이상.</p></div>
      <div class="card"><h2>기준선: 아무 종목이나 샀다면</h2>
        <table class="cmp"><thead><tr><th></th><th>학습 상승확률</th><th>평균</th><th>검증 상승확률</th><th>평균</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="note">'상승 확률 55%'는 이 기준과 비교해야 의미가 있습니다. 비용을 빼면 아무 종목이나 산 경우의 상승 확률은 50%보다 낮습니다.</p></div>
      <div class="card"><h2>t값과 '좋았던 해'</h2><p>같은 달 안의 신호들은 서로 닮아서, 사례가 1만 건이어도 실제로는 '몇십 개 달'의 경험일 수 있습니다. 그래서 같은 달의 신호를 하나로 묶어 신뢰도(t값)를 계산했습니다. 보통 2 이상이면 우연일 가능성이 낮다고 봅니다. '좋았던 해'는 그해 평균이 기준보다 높았던 해의 수입니다.</p>
        <p class="note">예: '11월' 같은 달력 규칙은 학습 기간에 11월이 7번뿐이라 통계적으로 확인하기 어렵습니다.</p></div>
      <div class="card warn"><h2>꼭 알아 둘 한계</h2>
        <ul><li>과거 통계이며 미래 수익을 보장하지 않습니다. 투자 판단과 책임은 본인에게 있습니다.</li>
        <li>평균 수익은 수수료를 뺀 값이지만 세금, 큰 금액 매매 시의 가격 충격은 반영하지 않았습니다.</li>
        <li>상장폐지 직전 정리매매 가격이 데이터에 없으면 손실이 실제보다 작게 잡힐 수 있습니다.</li>
        <li>'오전에 오른다' 같은 장중 규칙은 분 단위 데이터가 필요해 아직 포함하지 않았습니다.</li>
        <li>시장 환경이 바뀌면 규칙의 효과도 사라질 수 있습니다. 검증 기간 성적을 꾸준히 확인하세요.</li></ul></div>
      <div class="card"><h2>시험한 규칙·상태 ${CONDS.length}개</h2>${Object.entries(CONDS.reduce((a, c) => ((a[c.group] = a[c.group] || []).push(c), a), {})).map(([g, l]) =>
        `<div class="sec-title">${esc(g)}</div><ul>${l.map((c) => `<li>${esc(c.name.replace("업종: ", ""))}${c.desc ? ` <span class="note">— ${esc(c.desc)}</span>` : ""}</li>`).join("")}</ul>`).join("")}</div>
      <p class="note">데이터 기준일 ${esc(META.asof)} · 추천 계산 ${esc(META.updated)} · 조합 검증 ${esc(META.researched || META.updated)} (7일마다 다시 검증)</p></div>`;
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
    if (deferred) {
      card.hidden = false; btn.hidden = false;
      btn.onclick = async () => { deferred.prompt(); deferred = null; card.hidden = true; };
    } else if (iOS) {
      card.hidden = false; $("#installTxt").textContent = "앱으로 쓰려면: 사파리 공유 버튼 → 홈 화면에 추가";
    }
  }

  /* ── 시트·탭 ── */
  function openSheet(html) {
    $("#sheetBody").innerHTML = html;
    $("#sheet").hidden = false; $("#sheetBg").hidden = false;
    $("#sheetBody").scrollTop = 0;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() { $("#sheet").hidden = true; $("#sheetBg").hidden = true; document.body.style.overflow = ""; }
  $("#sheetClose").onclick = closeSheet; $("#sheetBg").onclick = closeSheet;
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  const RENDER = { picks: renderPicks, rules: renderRules, lab: renderLab, help: renderHelp };
  function render() {
    document.querySelectorAll("#hseg button").forEach((b) => b.classList.toggle("on", b.dataset.h === S.h));
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === S.view));
    Object.keys(RENDER).forEach((k) => ($("#v-" + k).hidden = k !== S.view));
    $("#hseg").style.visibility = S.view === "help" ? "hidden" : "";
    RENDER[S.view]();
  }
  document.querySelectorAll("#hseg button").forEach((b) => (b.onclick = () => {
    S.h = b.dataset.h; try { localStorage.setItem("h", S.h); } catch (e) {}
    render();
  }));
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => { S.view = b.dataset.v; render(); scrollTo(0, 0); }));

  /* ── 데이터 불러오기 ── */
  const get = (f) => fetch("data/" + f, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
  Promise.all([get("meta.json"), get("conditions.json"), get("combos.json"), get("today.json")])
    .then(([m, c, cb, t]) => {
      META = m; CONDS = c; COMBOS = cb; TODAY = t;
      CONDS.forEach((x, i) => { condIdx[x.id] = i; condById[x.id] = x; });
      COMBOS.forEach((x) => (comboByKey[keyOf(x.ids)] = x));
      $("#asof").textContent = `${META.asof} 마감 기준`;
      render();
    })
    .catch((e) => {
      $("#asof").textContent = "";
      $("#v-picks").innerHTML = `<div class="empty">결과 파일을 불러오지 못했습니다.<br>PC에서 <b>python run.py</b>를 먼저 실행하세요.<br><span class="note">${esc(e.message)}</span></div>`;
    });
})();
