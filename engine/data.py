"""데이터 수집: 코스피·코스닥 보통주(상장폐지 종목 포함)의 일봉과 업종 정보.

- 수정주가 일봉: FinanceDataReader (네이버 금융 출처)
- 상장폐지 종목도 함께 받아 생존 편향을 줄인다.
- cache/ 폴더에 저장하고, 다음 실행부터는 최근 구간만 이어 받는다.
"""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import FinanceDataReader as fdr
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
START = "2014-01-01"  # 2015년부터 검증, 앞 1년은 이동평균 계산용
DELIST_FROM = "2015-01-01"


def _is_common(code: str, name: str) -> bool:
    """보통주만 남긴다: 우선주(끝자리 0 아님), 스팩, 리츠·인프라 펀드 제외."""
    if not (isinstance(code, str) and len(code) == 6 and code.isdigit() and code.endswith("0")):
        return False
    bad = ("스팩", "리츠", "인프라", "기업인수목적")
    return not any(b in str(name) for b in bad)


def load_universe(refresh: bool = False) -> pd.DataFrame:
    """종목 목록: code, name, market, industry, delisted(bool), delist_date."""
    path = CACHE / "universe.parquet"
    if path.exists() and not refresh:
        return pd.read_parquet(path)
    CACHE.mkdir(exist_ok=True)

    desc = fdr.StockListing("KRX-DESC")
    cur = desc[desc["Market"].isin(["KOSPI", "KOSDAQ", "KOSDAQ GLOBAL"])].copy()
    cur = pd.DataFrame({
        "code": cur["Code"], "name": cur["Name"],
        "market": cur["Market"].replace({"KOSDAQ GLOBAL": "KOSDAQ"}),
        "industry": cur["Industry"].fillna("기타"),
        "delisted": False, "delist_date": pd.NaT,
    })

    dl = fdr.StockListing("KRX-DELISTING")
    dl["DelistingDate"] = pd.to_datetime(dl["DelistingDate"], errors="coerce")
    dl = dl[(dl["DelistingDate"] >= DELIST_FROM) & dl["Market"].isin(["KOSPI", "KOSDAQ"])
            & (dl["SecuGroup"] == "주권") & (dl["Kind"] == "보통주")]
    dl = pd.DataFrame({
        "code": dl["Symbol"], "name": dl["Name"], "market": dl["Market"],
        "industry": dl["Industry"].fillna("기타"),
        "delisted": True, "delist_date": dl["DelistingDate"],
    })
    dl = dl[~dl["code"].isin(cur["code"])]

    uni = pd.concat([cur, dl], ignore_index=True)
    uni = uni[[_is_common(c, n) for c, n in zip(uni["code"], uni["name"])]]
    uni = uni.drop_duplicates("code").reset_index(drop=True)
    uni.to_parquet(path)
    return uni


_NAVER = "https://fchart.stock.naver.com/sise.nhn"
_session = requests.Session()
_session.headers["User-Agent"] = "Mozilla/5.0"


def _fetch(code: str, start: str) -> pd.DataFrame | None:
    """네이버 차트에서 수정주가 일봉을 받는다(시간 제한 10초, 최대 4회 시도)."""
    days = (pd.Timestamp.now() - pd.Timestamp(start)).days
    count = min(6000, int(days * 0.75) + 30)   # 영업일 수 대략치
    for attempt in range(4):
        try:
            r = _session.get(_NAVER, params={"symbol": code, "timeframe": "day", "count": count, "requestType": 0},
                             timeout=10)
            r.raise_for_status()
            items = re.findall(r'<item data="([^"]+)"', r.text)
            if not items:
                return None
            rows = [x.split("|") for x in items]
            df = pd.DataFrame(rows, columns=["date", "Open", "High", "Low", "Close", "Volume"])
            df["date"] = pd.to_datetime(df["date"], format="%Y%m%d")
            for c in ["Open", "High", "Low", "Close", "Volume"]:
                df[c] = pd.to_numeric(df[c], errors="coerce")
            df = df[df["date"] >= start].set_index("date")
            df["code"] = code
            return df
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return None


def load_prices(uni: pd.DataFrame, update: bool = True, workers: int = 4, log=print) -> pd.DataFrame:
    """긴 형식(long) 일봉: date, code, Open, High, Low, Close, Volume."""
    path = CACHE / "prices.parquet"
    old = pd.read_parquet(path) if path.exists() else None

    if old is not None and not update:
        return old

    if old is None:
        jobs = {c: START for c in uni["code"]}
    else:
        # 이어 받기: 상장 중인 종목은 최근 10거래일 전부터 다시 받는다(수정주가 변경 대비 일부 겹침).
        last = old["date"].max()
        restart = (last - pd.Timedelta(days=15)).strftime("%Y-%m-%d")
        have = set(old["code"].unique())
        jobs = {}
        for c, d in zip(uni["code"], uni["delisted"]):
            if c not in have:
                jobs[c] = START
            elif not d:
                jobs[c] = restart

    frames, done = [], 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_fetch, c, s): c for c, s in jobs.items()}
        for f in as_completed(futs):
            df = f.result()
            if df is not None:
                frames.append(df)
            done += 1
            if done % 200 == 0:
                log(f"  주가 수신 {done}/{len(jobs)}")

    new = pd.concat(frames).reset_index()
    new["date"] = pd.to_datetime(new["date"])

    if old is not None:
        # 새로 받은 종목은 해당 종목 전체를 교체(수정주가 반영), 나머지는 기존 유지
        full_codes = {c for c, s in jobs.items() if s == START}
        old = old[~old["code"].isin(full_codes)]
        restart_min = new.loc[~new["code"].isin(full_codes), "date"].min()
        if pd.notna(restart_min):
            refreshed = set(new.loc[~new["code"].isin(full_codes), "code"])
            # 겹치는 구간에서 가격이 달라졌으면(액면분할 등) 그 종목은 전체를 다시 받는다
            # (기존 데이터의 마지막 날은 장중 미완성 값일 수 있어 비교에서 뺀다)
            chk = old[old["code"].isin(refreshed) & (old["date"] >= restart_min)
                      & (old["date"] < old["date"].max())].merge(
                new[["date", "code", "Close"]], on=["date", "code"], suffixes=("", "_n"))
            changed = set(chk.loc[(chk["Close"] - chk["Close_n"]).abs() > 0.5, "code"])
            if changed:
                log(f"  수정주가 변경 {len(changed)}종목 전체 재수신")
                with ThreadPoolExecutor(max_workers=workers) as ex:
                    refetch = [df for df in ex.map(lambda c: _fetch(c, START), changed) if df is not None]
                if refetch:
                    rf = pd.concat(refetch).reset_index()
                    new = pd.concat([new[~new["code"].isin(changed)], rf])
                old = old[~old["code"].isin(changed)]
            old = old[~(old["code"].isin(refreshed) & (old["date"] >= restart_min))]
        new = pd.concat([old, new])

    new = new.drop_duplicates(["date", "code"], keep="last").sort_values(["code", "date"])
    for col in ["Open", "High", "Low", "Close"]:
        new[col] = new[col].astype("float32")
    new["Volume"] = new["Volume"].astype("float64")
    new = new.reset_index(drop=True)
    CACHE.mkdir(exist_ok=True)
    new.to_parquet(path)
    return new


def load_quotes() -> pd.DataFrame | None:
    """거래소 현재 종목 목록: 상장주식수·거래량·거래대금(조회 시점 기준). 실패하면 None."""
    try:
        with ThreadPoolExecutor(max_workers=1) as ex:
            df = ex.submit(fdr.StockListing, "KRX").result(timeout=60)
        df = df[["Code", "Close", "Volume", "Amount", "Stocks"]].rename(columns={"Code": "code"})
        return df.set_index("code")
    except Exception:
        return None


def load_index(update: bool = True) -> pd.DataFrame:
    """코스피(KS11)·코스닥(KQ11) 지수 종가."""
    path = CACHE / "index.parquet"
    if path.exists() and not update:
        return pd.read_parquet(path)
    ks = fdr.DataReader("KS11", START)["Close"].rename("KOSPI")
    kq = fdr.DataReader("KQ11", START)["Close"].rename("KOSDAQ")
    idx = pd.concat([ks, kq], axis=1)
    idx.index = pd.to_datetime(idx.index)
    idx.index.name = "date"
    CACHE.mkdir(exist_ok=True)
    idx.to_parquet(path)
    return idx


if __name__ == "__main__":
    t = time.time()
    u = load_universe(refresh=True)
    print(f"종목 {len(u)}개 (상장폐지 {int(u['delisted'].sum())}개)")
    load_index()
    p = load_prices(u)
    print(f"일봉 {len(p):,}행, {p['code'].nunique()}종목, {p['date'].min().date()} ~ {p['date'].max().date()}, {time.time()-t:.0f}초")
