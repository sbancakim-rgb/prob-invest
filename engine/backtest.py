"""조건 조합 검증(백테스트)과 오늘의 종목 추천.

가정
- 신호일 t 장 마감 후 조건 판정 → t+1일 시가 매수 → t+h일 종가 매도 (h = 1, 5, 20)
- 왕복 거래비용 0.35% 차감 (거래세 0.20% + 수수료 + 시초가 매수 슬리피지, 보수적으로)
- 20일 평균 거래대금 3억 원 미만, 거래정지(거래량 0) 종목은 제외
- 상장폐지 종목은 마지막 거래 가격으로 청산했다고 본다

검증 방식
- 학습 기간에서 조합을 고르고, 검증 기간(한 번도 안 본 데이터)에서 다시 확인한다.
- 같은 달(연-월) 안의 신호는 하나로 묶어 t값을 계산한다(신호끼리 서로 닮아 있으므로).
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .rules import GROUPS, Cond

HORIZONS = (1, 5, 20)
COST = 0.0035
MIN_AMT = 3e8
TRAIN = ("2015-01-01", "2021-12-31")
TEST = ("2022-01-01", "2099-12-31")

# 통과 기준
MIN_N_TRAIN = 300
MIN_N_TEST = 100
MIN_CLUSTERS = 6
T_TRAIN = 3.0   # 조합을 수천 개 시험하므로 일부러 엄격하게
T_TEST_A = 2.0


@dataclass
class Panel:
    dates: pd.DatetimeIndex
    codes: pd.Index
    obs_d: np.ndarray          # 관측치의 날짜 위치
    obs_c: np.ndarray          # 관측치의 종목 위치
    ret: dict                  # h -> float32 배열(관측치별 순수익률, 없으면 nan)
    period: np.ndarray         # 0=학습, 1=검증, -1=그 외
    cluster: np.ndarray        # 연-월 번호
    year: np.ndarray
    base: dict = field(default_factory=dict)   # (h, p) -> (평균, 승률)
    pmask: dict = field(default_factory=dict)
    n_cluster: int = 0
    n_year: int = 0
    today_idx: int = -1


def make_wide(prices: pd.DataFrame) -> dict:
    P = {}
    for k, col in (("O", "Open"), ("H", "High"), ("L", "Low"), ("C", "Close"), ("V", "Volume")):
        P[k] = prices.pivot(index="date", columns="code", values=col).sort_index()
    # 주가 0(거래정지 표기)은 결측 처리
    for k in ("O", "H", "L", "C"):
        P[k] = P[k].where(P[k] > 0)
    P["AMT"] = P["C"] * P["V"]
    return P


def tradable(P: dict) -> pd.DataFrame:
    """그날 거래 가능한 종목(가격 있음, 거래량>0, 20일 평균 거래대금 기준 통과)."""
    amt20 = P["AMT"].rolling(20, min_periods=20).mean()
    return P["C"].notna() & (P["V"] > 0) & (amt20 >= MIN_AMT)


def build_panel(P: dict) -> Panel:
    C, O, V = P["C"], P["O"], P["V"]
    dates, codes = C.index, C.columns
    T = len(dates)

    # 상장폐지 종목: 마지막 거래 이후는 마지막 종가로 청산
    Cf = C.ffill().to_numpy(np.float64)
    On = O.shift(-1).to_numpy(np.float64)          # 다음 날 시가
    Vn = V.shift(-1).to_numpy(np.float64)
    amt20 = P["AMT"].rolling(20, min_periods=20).mean().to_numpy()
    Cn = C.to_numpy()
    Vv = V.to_numpy()

    valid = (~np.isnan(Cn)) & (Vv > 0) & (amt20 >= MIN_AMT)
    valid_trade = valid & (~np.isnan(On)) & (Vn > 0)
    # 오늘(마지막 날)은 수익률이 없어도 추천용으로 필요 → 별도 처리
    dpos = np.arange(T)
    in_range = (dates >= TRAIN[0])
    valid_trade &= in_range[:, None]

    od, oc = np.nonzero(valid_trade)
    rets = {}
    for h in HORIZONS:
        exitp = np.full_like(Cf, np.nan)
        exitp[: T - h] = Cf[h:]
        r = exitp[od, oc] / On[od, oc] - 1 - COST
        r = np.clip(r, -0.95, 3.0)
        rets[h] = r.astype(np.float32)

    d = dates[od]
    period = np.full(len(od), -1, np.int8)
    period[(d >= TRAIN[0]) & (d <= TRAIN[1])] = 0
    period[(d >= TEST[0]) & (d <= TEST[1])] = 1
    cluster = (d.year * 12 + d.month - 1).to_numpy().astype(np.int32)
    cluster -= cluster.min()

    year = (d.year.to_numpy() - d.year.min()).astype(np.int32)
    panel = Panel(dates, codes, od.astype(np.int32), oc.astype(np.int32), rets,
                  period, cluster, year)
    panel.n_cluster = int(cluster.max()) + 1
    panel.n_year = int(year.max()) + 1
    panel.pmask = {(h, p): (period == p) & ~np.isnan(rets[h]) for h in HORIZONS for p in (0, 1)}
    for h in HORIZONS:
        for p in (0, 1):
            r = rets[h][(period == p) & ~np.isnan(rets[h])]
            panel.base[(h, p)] = (float(r.mean()), float((r > 0).mean()), int(len(r)))
    panel.today_idx = T - 1
    panel._valid_today = valid[T - 1]
    return panel


def flatten(conds: list[Cond], panel: Panel) -> np.ndarray:
    """조건별 관측치 불리언 → (조건 수, 관측치 수) 배열."""
    M = np.zeros((len(conds), len(panel.obs_d)), dtype=bool)
    for i, c in enumerate(conds):
        M[i] = c.frame.to_numpy()[panel.obs_d, panel.obs_c]
    return M


def stats(mask: np.ndarray, panel: Panel, h: int, p: int) -> dict | None:
    r = panel.ret[h]
    sel = mask & panel.pmask[(h, p)]
    idx = np.flatnonzero(sel)
    n = len(idx)
    if n == 0:
        return None
    rr = r[idx].astype(np.float64)
    bmean, bwin, _ = panel.base[(h, p)]
    cl = panel.cluster[idx]
    cnt = np.bincount(cl, minlength=panel.n_cluster)
    sm = np.bincount(cl, weights=rr - bmean, minlength=panel.n_cluster)
    has = cnt > 0
    cm = sm[has] / cnt[has]
    k = len(cm)
    sd = cm.std(ddof=1) if k >= 2 else 0.0
    t = float(cm.mean() / (sd / math.sqrt(k))) if sd > 0 else 0.0
    yi = panel.year[idx]
    ycnt = np.bincount(yi, minlength=panel.n_year)
    ysum = np.bincount(yi, weights=rr, minlength=panel.n_year)
    yh = ycnt > 0
    ypos = int(((ysum[yh] / ycnt[yh]) > bmean).sum())
    win = float((rr > 0).mean())
    mean = float(rr.mean())
    return {
        "n": n, "k": int(k), "mean": mean, "win": win,
        "med": float(np.median(rr)), "ex": mean - bmean, "wex": win - bwin,
        "t": t, "yrs": int(yh.sum()), "ypos": ypos,
    }


def grade(tr: dict | None, te: dict | None) -> str:
    """A/B = 통과, X = 학습에선 좋았지만 검증에서 탈락, '' = 학습 단계에서 탈락.
    통과하려면 '기준보다 낫다'만으로는 부족하고, 비용을 빼고도 실제로 벌었어야 한다."""
    if not tr or not te:
        return ""
    if tr["n"] < MIN_N_TRAIN or tr["k"] < MIN_CLUSTERS or tr["t"] < T_TRAIN or tr["mean"] <= 0:
        return ""
    if (te["n"] < MIN_N_TEST or te["k"] < 4 or te["mean"] <= 0 or te["ex"] <= 0
            or te["wex"] <= 0 or te["win"] < 0.5):
        return "X"   # 우연이었거나 시장 환경이 바뀌어 효과가 사라졌을 가능성
    return "A" if te["t"] >= T_TEST_A else "B"


def evaluate(mask, panel):
    out = {}
    for h in HORIZONS:
        tr = stats(mask, panel, h, 0)
        te = stats(mask, panel, h, 1)
        out[h] = {"train": tr, "test": te, "grade": grade(tr, te)}
    return out


def _can_combine(conds, ids):
    seen = set()
    for i in ids:
        g = conds[i].group
        if GROUPS.get(g, False):
            if g in seen:
                return False
            seen.add(g)
    return True


def search(conds: list[Cond], M: np.ndarray, panel: Panel, beam: int = 250, workers: int = 8, log=print) -> list[dict]:
    """단일 → 2개 조합(전수) → 3개 조합(빔 탐색). 조합 선택은 학습 기간 성과로만 한다."""
    from concurrent.futures import ThreadPoolExecutor

    train_mask = panel.period == 0
    nC = len(conds)

    def run(ids):
        m = M[ids[0]] & M[ids[1]] if len(ids) > 1 else M[ids[0]].copy()
        for i in ids[2:]:
            m &= M[i]
        if int(np.count_nonzero(m & train_mask)) < MIN_N_TRAIN:
            return None
        return {"ids": [conds[i].id for i in ids], "ev": evaluate(m, panel)}

    def run_all(jobs, label):
        out = []
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for j, r in enumerate(ex.map(run, jobs, chunksize=16)):
                if r is not None:
                    out.append(r)
                if (j + 1) % 2000 == 0:
                    log(f"  {label} {j + 1}/{len(jobs)}")
        log(f"  {label} {len(jobs)}개 시험 → 표본 충분 {len(out)}개")
        return out

    results = run_all([[i] for i in range(nC)], "단일 조건")
    pairs = [list(p) for p in itertools.combinations(range(nC), 2) if _can_combine(conds, p)]
    two = run_all(pairs, "2개 조합")
    results += two

    def best_t(rec):
        return max((rec["ev"][h]["train"] or {"t": -9})["t"] for h in HORIZONS)

    pos = {c.id: i for i, c in enumerate(conds)}
    top = sorted(two, key=best_t, reverse=True)[:beam]
    seen, cand = set(), []
    for r in top:
        base = [pos[x] for x in r["ids"]]
        for i in range(nC):
            if i in base:
                continue
            ids = tuple(sorted(base + [i]))
            if ids in seen or not _can_combine(conds, ids):
                continue
            seen.add(ids)
            cand.append(list(ids))
    results += run_all(cand, "3개 조합")
    return results


def today_matches(conds: list[Cond], panel: Panel) -> np.ndarray:
    """오늘 날짜의 (조건 × 종목) 불리언. 거래대금 기준 미달 종목은 False."""
    T = panel.today_idx
    out = np.zeros((len(conds), len(panel.codes)), dtype=bool)
    for i, c in enumerate(conds):
        out[i] = c.frame.iloc[T].to_numpy()
    out &= panel._valid_today[None, :]
    return out
