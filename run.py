"""확률투자 실행 파일.

사용법 (장 마감 후, 오후 4시 이후 권장)
  python run.py               데이터 갱신 + 오늘의 추천 → docs/data/*.json
                              (조합 검증은 7일마다, 또는 규칙이 바뀌었을 때 자동으로 다시 한다)
  python run.py --research    조합 검증을 지금 강제로 다시 실행
  python run.py --no-update   다운로드 없이 저장된 데이터로만 계산
"""
from __future__ import annotations

import argparse
import hashlib
import pickle
import json
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
    log(f"  {prices['code'].nunique()}종목, 마지막 거래일 {prices['date'].max().date()}")

    log("2/5 조건 계산")
    P = bt.make_wide(prices)
    info_df = info.reindex(P["C"].columns).reset_index()
    conds = build_conditions(P, info_df, idx, universe=bt.tradable(P))
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
        results, base_saved = cached["results"], cached["base"]
        panel.base = base_saved
        research_when = cached["when"]
        log(f"3/5 조합 검증: 저장된 결과 사용({cached['when']:%Y-%m-%d %H:%M} 계산)")
    else:
        log("3/5 조합 검증(학습 2015~2021 → 검증 2022~)")
        M = bt.flatten(conds, panel)
        results = bt.search(conds, M, panel, log=log)
        del M
        research_when = datetime.now()
        rpath.write_bytes(pickle.dumps({"when": datetime.now(), "sig": sig, "results": results, "base": panel.base}))

    log("4/5 오늘의 추천 종목")
    TM = bt.today_matches(conds, panel)
    today = panel.dates[panel.today_idx]
    pos = {c.id: i for i, c in enumerate(conds)}
    codes = panel.codes

    def combo_today(ids):
        m = TM[pos[ids[0]]].copy()
        for x in ids[1:]:
            m &= TM[pos[x]]
        return np.flatnonzero(m)

    picks = {}
    for h in bt.HORIZONS:
        good = [r for r in results if r["ev"][h]["grade"] in ("A", "B")]
        good.sort(key=lambda r: (r["ev"][h]["grade"] != "A", -r["ev"][h]["test"]["ex"]))
        per_stock = {}
        for rank, r in enumerate(good):
            for ci in combo_today(r["ids"]):
                per_stock.setdefault(int(ci), []).append(rank)
        rows = []
        for ci, ranks in per_stock.items():
            best = good[ranks[0]]
            rows.append({"c": int(ci), "best": ranks[0], "combos": ranks[:8], "cnt": len(ranks),
                         "g": best["ev"][h]["grade"], "ex": best["ev"][h]["test"]["ex"]})
        rows.sort(key=lambda x: (x["g"] != "A", -x["ex"], -x["cnt"]))
        picks[h] = {"combos": [r["ids"] for r in good], "rows": rows[:40]}

    log("5/5 결과 저장")
    OUT.mkdir(parents=True, exist_ok=True)

    # 종목 정보와 최근 120일 종가(추천 종목만)
    used = sorted({r["c"] for h in picks for r in picks[h]["rows"]})
    C = P["C"]
    stocks = {}
    for ci in range(len(codes)):
        code = codes[ci]
        stocks[code] = [str(info.at[code, "name"]) if code in info.index else code,
                        str(info.at[code, "market"]) if code in info.index else "",
                        str(info.at[code, "industry"]) if code in info.index else ""]
    spark, risk = {}, {}
    Vw = P["V"]
    for ci in used:
        s = C.iloc[-120:, ci].dropna()
        spark[codes[ci]] = [round(float(v), 0) for v in s]
        # 위험 표시: 최근 거래정지, 하한가·상한가 마감, 저가주
        flags = []
        halt = int((Vw.iloc[-60:, ci].fillna(0) == 0).sum())
        if halt:
            flags.append(f"최근 60거래일 중 {halt}일 거래정지")
        c0, c1 = C.iloc[-1, ci], C.iloc[-2, ci]
        if pd.notna(c0) and pd.notna(c1) and c1 > 0:
            r = c0 / c1 - 1
            if r <= -0.29:
                flags.append("오늘 하한가 마감")
            elif r >= 0.29:
                flags.append("오늘 상한가 마감")
        if pd.notna(c0) and c0 < 1000:
            flags.append("주가 1,000원 미만")
        if flags:
            risk[codes[ci]] = flags

    cond_list = [{"id": c.id, "name": c.name, "group": c.group, "desc": c.desc,
                  "excl": GROUPS.get(c.group, False)} for c in conds]
    today_members = {c.id: [codes[i] for i in np.flatnonzero(TM[k])] for k, c in enumerate(conds)}

    base = {str(h): {"train": list(panel.base[(h, 0)]), "test": list(panel.base[(h, 1)])} for h in bt.HORIZONS}
    meta = {
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "researched": research_when.strftime("%Y-%m-%d %H:%M"),
        "asof": today.strftime("%Y-%m-%d"),
        "train": [bt.TRAIN[0], bt.TRAIN[1]],
        "test": [bt.TEST[0], panel.dates[-1].strftime("%Y-%m-%d")],
        "cost": bt.COST, "min_amt": bt.MIN_AMT,
        "criteria": {"min_n_train": bt.MIN_N_TRAIN, "min_n_test": bt.MIN_N_TEST,
                     "t_train": bt.T_TRAIN, "t_test_a": bt.T_TEST_A, "min_clusters": bt.MIN_CLUSTERS},
        "n_stocks": int(prices["code"].nunique()),
        "n_delisted": int(uni["delisted"].sum()),
        "n_tested": len(results),
        "base": base,
        "horizons": list(bt.HORIZONS),
    }

    combos = []
    for r in results:
        combos.append({"ids": r["ids"],
                       "h": {str(h): [r["ev"][h]["grade"], pack(r["ev"][h]["train"]), pack(r["ev"][h]["test"])]
                             for h in bt.HORIZONS}})
    # 앱 용량을 줄이기 위해: 단일·2개 조합은 전부, 3개 조합은 등급이 붙은 것만
    combos = [c for c in combos if len(c["ids"]) <= 2 or any(c["h"][str(h)][0] for h in bt.HORIZONS)]

    picks_out = {}
    for h in bt.HORIZONS:
        pk = picks[h]
        used_ranks = sorted({k for r in pk["rows"] for k in r["combos"]})
        picks_out[str(h)] = {
            "combos": {str(k): pk["combos"][k] for k in used_ranks},
            "rows": [{"code": codes[r["c"]], "combos": r["combos"], "cnt": r["cnt"], "g": r["g"]} for r in pk["rows"]],
            "n_good": len(pk["combos"]),
        }

    def dump(name, obj):
        (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    dump("meta.json", meta)
    dump("conditions.json", cond_list)
    dump("combos.json", combos)
    dump("today.json", {"asof": meta["asof"], "picks": picks_out, "members": today_members,
                        "stocks": stocks, "spark": spark, "risk": risk})
    log(f"완료: 조합 {len(combos)}개 저장, {time.time() - t0:.0f}초")
    for h in bt.HORIZONS:
        g = [c for c in combos if c["h"][str(h)][0] in ("A", "B")]
        x = [c for c in combos if c["h"][str(h)][0] == "X"]
        log(f"  {h}일: 통과 {len(g)}개(A {sum(c['h'][str(h)][0]=='A' for c in g)}), 검증 탈락 {len(x)}개, 오늘 추천 {len(picks_out[str(h)]['rows'])}종목")


if __name__ == "__main__":
    main()
