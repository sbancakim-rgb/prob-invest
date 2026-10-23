"""확률투자 실행 파일.

사용법 (장 마감 후 실행. 평일 15:40 전에 실행하면 오늘의 미완성 일봉은 자동으로 뺀다)
  python run.py               데이터 갱신 + 오늘의 추천 + 추천 기록 결과 → docs/data/*.json
                              (조합 검증은 7일마다, 또는 규칙이 바뀌었을 때 자동으로 다시 한다)
  python run.py --research    조합 검증을 지금 강제로 다시 실행
  python run.py --no-update   다운로드 없이 저장된 데이터로만 계산

만드는 파일
  meta.json        기준일, 검증 기간, 기준선 등
  conditions.json  규칙·상태 목록
  combos.json      조합별 학습·검증 성적
  today.json       오늘의 추천, 조건별 해당 종목, 시가총액·거래량·거래대금, 위험 표시
  prices.json      전 종목 최근 120거래일 시가·종가(차트·관심종목용)
  track.json       날짜별 추천 기록과 실제 결과
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from engine import backtest as bt
from engine import data
from engine.rules import GROUPS, build_conditions

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "docs" / "data"
TOP = 40            # 기간별 하루 추천 종목 수
BACKFILL_DAYS = 60  # 기록이 없을 때 사후 계산할 과거 거래일 수
CHART_DAYS = 120    # prices.json에 담을 거래일 수


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def r4(x):
    return None if x is None else round(float(x), 4)


def pack(s: dict | None):
    """통계 dict → 짧은 배열 [n, 승률, 평균, 중앙값, 초과수익, t, 상승한해, 전체해]."""
    if not s:
        return None
    return [s["n"], r4(s["win"]), r4(s["mean"]), r4(s["med"]), r4(s["ex"]), round(s["t"], 2), s["ypos"], s["yrs"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-update", action="store_true")
    ap.add_argument("--research", action="store_true")
    args = ap.parse_args()
    t0 = time.time()

    log("1/5 종목·주가 데이터 준비")
    uni = data.load_universe(refresh=not args.no_update)
    idx = data.load_index(update=not args.no_update)
    prices = data.load_prices(uni, update=not args.no_update, log=log)
    info = uni.drop_duplicates("code").set_index("code")
    # 장중에 실행하면 오늘 일봉이 아직 미완성이다 → 평일 15:40 전에는 오늘 데이터를 뺀다
    now = datetime.now()
    if now.weekday() < 5 and (now.hour, now.minute) < (15, 40):
        cut = pd.Timestamp(now.date())
        if prices["date"].max() >= cut:
            prices = prices[prices["date"] < cut]
            idx = idx[idx.index < cut]
            log("  장 마감 전이라 오늘의 미완성 일봉은 제외")
    log(f"  {prices['code'].nunique()}종목, 마지막 거래일 {prices['date'].max().date()}")

    log("2/5 조건 계산")
    P = bt.make_wide(prices)
    info_df = info.reindex(P["C"].columns).reset_index()
    U = bt.tradable(P)
    conds = build_conditions(P, info_df, idx, universe=U)
    panel = bt.build_panel(P)
    log(f"  조건 {len(conds)}개, 관측치 {len(panel.obs_d):,}개")

    # 조합 검증은 무겁다: 7일이 지났거나 규칙 목록이 바뀌었을 때만 다시 한다
    sig = hashlib.md5("|".join(c.id for c in conds).encode()).hexdigest()
    rpath = ROOT / "cache" / "research.pkl"
    cached = None
    if rpath.exists() and not args.research:
        cached = pickle.loads(rpath.read_bytes())
        age = (datetime.now() - cached["when"]).days
        if cached["sig"] != sig or age >= 7:
            log(f"  저장된 검증 결과 무효(규칙 변경={cached['sig'] != sig}, {age}일 경과)")
            cached = None
    if cached:
        results = cached["results"]
        panel.base = cached["base"]
        research_when = cached["when"]
        log(f"3/5 조합 검증: 저장된 결과 사용({research_when:%Y-%m-%d %H:%M} 계산)")
    else:
        log("3/5 조합 검증(학습 2015~2021 → 검증 2022~)")
        M = bt.flatten(conds, panel)
        results = bt.search(conds, M, panel, log=log)
        del M
        research_when = datetime.now()
        rpath.write_bytes(pickle.dumps({"when": research_when, "sig": sig, "results": results, "base": panel.base}))

    log("4/5 추천 종목(오늘 + 기록)")
    codes, dates = panel.codes, panel.dates
    T = len(dates)
    pos = {c.id: i for i, c in enumerate(conds)}
    cond_np = [c.frame.to_numpy() for c in conds]
    U_np = U.to_numpy()
    C, O, Vw = P["C"], P["O"], P["V"]

    # 기간별 통과 조합: A 먼저, 검증 기간 초과수익 순
    good = {}
    for h in bt.HORIZONS:
        g = [r for r in results if r["ev"][h]["grade"] in ("A", "B")]
        g.sort(key=lambda r: (r["ev"][h]["grade"] != "A", -r["ev"][h]["test"]["ex"]))
        good[h] = g

    def picks_on(d: int):
        """d번째 날 장 마감 기준, 통과 조합의 조건이 모두 일치하는 종목(기간별 상위 TOP개)."""
        TM = np.stack([cf[d] for cf in cond_np]) & U_np[d][None, :]
        out = {}
        for h in bt.HORIZONS:
            per_stock = {}
            for rank, r in enumerate(good[h]):
                m = TM[pos[r["ids"][0]]].copy()
                for x in r["ids"][1:]:
                    m &= TM[pos[x]]
                for ci in np.flatnonzero(m):
                    per_stock.setdefault(int(ci), []).append(rank)
            rows = []
            for ci, ranks in per_stock.items():
                te = good[h][ranks[0]]["ev"][h]["test"]
                rows.append({"c": ci, "combos": ranks[:8], "cnt": len(ranks),
                             "g": good[h][ranks[0]]["ev"][h]["grade"], "ex": te["ex"],
                             "w": te["win"], "m": te["mean"]})
            rows.sort(key=lambda x: (x["g"] != "A", -x["ex"], -x["cnt"]))
            out[h] = rows[:TOP]
        return out, TM

    today_picks, TM = picks_on(T - 1)
    ds_today = dates[T - 1].strftime("%Y-%m-%d")

    # ── 추천 기록: 매일의 추천과 당시 예상(검증 기간 승률·평균수익) ──
    tpath = OUT / "track.json"
    recs = json.loads(tpath.read_text(encoding="utf-8")).get("base", []) if tpath.exists() else []
    first_time = not recs
    recs = [r for r in recs if r[0] != ds_today]   # 같은 날 다시 실행하면 그날 기록은 새로 쓴다

    def add_recs(d: int, pk: dict, backfill: int):
        ds = dates[d].strftime("%Y-%m-%d")
        for h in bt.HORIZONS:
            for rk, r in enumerate(pk[h]):
                recs.append([ds, h, codes[r["c"]], r["g"], r4(r["w"]), r4(r["m"]), r["cnt"], backfill, rk + 1])

    if first_time:
        log(f"  추천 기록이 없어 지난 {BACKFILL_DAYS}거래일을 같은 규칙으로 사후 계산")
        for d in range(T - 1 - BACKFILL_DAYS, T - 1):
            add_recs(d, picks_on(d)[0], 1)
    add_recs(T - 1, today_picks, 0)

    # 실제 결과: 다음 날 시가에 사서 h거래일 뒤 종가에 판다(비용 차감). 아직 기간이 안 끝났으면 현재가 기준
    didx = {d.strftime("%Y-%m-%d"): i for i, d in enumerate(dates)}
    cidx = {c: i for i, c in enumerate(codes)}
    Cf = C.ffill().to_numpy()
    On = O.to_numpy()
    track = []
    for r in recs:
        ds, h, code = r[0], r[1], r[2]
        d, ci = didx.get(ds), cidx.get(code)
        entry = exitp = ret = None
        status, held = "wait", 0
        if d is not None and ci is not None and d + 1 < T:
            e = On[d + 1, ci]
            if np.isnan(e):
                status = "skip"          # 다음 날 거래정지 등으로 살 수 없었음
            else:
                last = min(d + h, T - 1)
                entry, exitp = float(e), float(Cf[last, ci])
                ret = exitp / entry - 1 - bt.COST
                held = last - d
                status = "done" if d + h <= T - 1 else "open"
        track.append(r + [entry, exitp, None if ret is None else round(ret, 4), status, held])
    track.sort(key=lambda x: (x[0], -x[1], -x[8]), reverse=True)

    log("5/5 결과 저장")
    OUT.mkdir(parents=True, exist_ok=True)

    stocks = {code: [str(info.at[code, "name"]) if code in info.index else code,
                     str(info.at[code, "market"]) if code in info.index else "",
                     str(info.at[code, "industry"]) if code in info.index else ""] for code in codes}

    # 기준일에 거래된 모든 종목의 시가총액·거래량·거래대금과 위험 표시
    quotes = data.load_quotes() if not args.no_update else None
    risk, quote = {}, {}
    live = np.flatnonzero(C.iloc[-1].notna().to_numpy())
    for ci in live:
        code = codes[ci]
        c0, c1 = C.iloc[-1, ci], C.iloc[-2, ci]
        flags = []
        halt = int((Vw.iloc[-60:, ci].fillna(0) == 0).sum())
        if halt:
            flags.append(f"최근 60거래일 중 {halt}일 거래정지")
        if pd.notna(c1) and c1 > 0:
            chg = c0 / c1 - 1
            if chg <= -0.29:
                flags.append("기준일 하한가 마감")
            elif chg >= 0.29:
                flags.append("기준일 상한가 마감")
        if c0 < 1000:
            flags.append("주가 1,000원 미만")
        if flags:
            risk[code] = flags
        vol = Vw.iloc[-1, ci]
        mcap = amt = None
        exact = False
        if quotes is not None and code in quotes.index:
            q = quotes.loc[code]
            if pd.notna(q["Stocks"]):
                mcap = float(q["Stocks"]) * float(c0)
            # 거래소 목록이 같은 날 것(거래량 일치)이면 실제 거래대금을 쓴다
            if pd.notna(vol) and q["Volume"] == vol and pd.notna(q["Amount"]):
                amt, exact = float(q["Amount"]), True
        if amt is None and pd.notna(vol):
            # 추정: 평균가(고가·저가·종가) × 거래량. 고가·저가가 없으면 종가로
            avgp = np.nanmean([P["H"].iloc[-1, ci], P["L"].iloc[-1, ci], c0])
            amt = float(vol) * float(avgp)
        quote[code] = [None if mcap is None else round(mcap), None if pd.isna(vol) else int(vol),
                       None if amt is None else round(amt), exact]

    # 최근 거래일 시가·종가(전 종목)
    def col(arr):
        return [None if np.isnan(v) else int(round(v)) for v in arr]
    Cw, Ow = C.iloc[-CHART_DAYS:].to_numpy(), O.iloc[-CHART_DAYS:].to_numpy()
    prices_out = {"dates": [d.strftime("%Y-%m-%d") for d in dates[-CHART_DAYS:]],
                  "c": {codes[ci]: col(Cw[:, ci]) for ci in live},
                  "o": {codes[ci]: col(Ow[:, ci]) for ci in live}}

    cond_list = [{"id": c.id, "name": c.name, "group": c.group, "desc": c.desc,
                  "excl": GROUPS.get(c.group, False)} for c in conds]
    today_members = {c.id: [codes[i] for i in np.flatnonzero(TM[k])] for k, c in enumerate(conds)}

    base = {str(h): {"train": list(panel.base[(h, 0)]), "test": list(panel.base[(h, 1)])} for h in bt.HORIZONS}
    meta = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "researched": research_when.strftime("%Y-%m-%d %H:%M"),
        "asof": ds_today,
        "train": [bt.TRAIN[0], bt.TRAIN[1]],
        "test": [bt.TEST[0], ds_today],
        "cost": bt.COST, "min_amt": bt.MIN_AMT,
        "criteria": {"min_n_train": bt.MIN_N_TRAIN, "min_n_test": bt.MIN_N_TEST,
                     "t_train": bt.T_TRAIN, "t_test_a": bt.T_TEST_A, "min_clusters": bt.MIN_CLUSTERS},
        "n_stocks": int(prices["code"].nunique()),
        "n_delisted": int(uni["delisted"].sum()),
        "n_tested": len(results),
        "base": base,
        "horizons": list(bt.HORIZONS),
        "top": TOP,
    }

    combos = [{"ids": r["ids"],
               "h": {str(h): [r["ev"][h]["grade"], pack(r["ev"][h]["train"]), pack(r["ev"][h]["test"])]
                     for h in bt.HORIZONS}} for r in results]
    # 앱 용량을 줄이기 위해: 단일·2개 조합은 전부, 3개 조합은 등급이 붙은 것만
    combos = [c for c in combos if len(c["ids"]) <= 2 or any(c["h"][str(h)][0] for h in bt.HORIZONS)]

    picks_out = {}
    for h in bt.HORIZONS:
        rows = today_picks[h]
        used_ranks = sorted({k for r in rows for k in r["combos"]})
        picks_out[str(h)] = {
            "combos": {str(k): good[h][k]["ids"] for k in used_ranks},
            "rows": [{"code": codes[r["c"]], "combos": r["combos"], "cnt": r["cnt"], "g": r["g"]} for r in rows],
            "n_good": len(good[h]),
        }

    def dump(name, obj):
        (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    dump("meta.json", meta)
    dump("conditions.json", cond_list)
    dump("combos.json", combos)
    dump("today.json", {"asof": ds_today, "picks": picks_out, "members": today_members,
                        "stocks": stocks, "risk": risk, "quote": quote})
    dump("prices.json", prices_out)
    # base: 추천 당시 기록(이후 바뀌지 않음) / rows: 기록 + 실제 결과
    # rows 열: 날짜, 기간, 종목, 등급, 예상승률, 예상평균, 일치조합수, 사후계산, 순위, 매수가, 현재·매도가, 수익률, 상태, 보유일
    dump("track.json", {"base": [r[:9] for r in track], "rows": track, "cost": bt.COST})
    log(f"완료: 조합 {len(combos)}개, 추천 기록 {len(track)}건, {time.time() - t0:.0f}초")
    for h in bt.HORIZONS:
        log(f"  {h}일: 통과 조합 {len(good[h])}개, 오늘 추천 {len(picks_out[str(h)]['rows'])}종목")


if __name__ == "__main__":
    main()
