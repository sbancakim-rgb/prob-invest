"""규칙·상태 라이브러리.

모든 조건은 '그날 장 마감 후 알 수 있는 정보'만 쓴다(미래 데이터 사용 금지).
신호가 뜬 다음 날 시가에 사서 N거래일 뒤 종가에 판다고 가정한다.

조건 추가 방법: build_conditions() 안에 add(...) 한 줄을 넣으면 된다.
  add(id, 이름, 그룹, 불리언 표, 설명)
  - GROUPS에서 True인 그룹은 '하나만 선택' 그룹이라 같은 그룹끼리 조합하지 않는다(예: 1월과 2월).

규칙을 고른 기준: 주식시장 연구에서 반복 보고된 현상(모멘텀, 단기 반전, 저변동성,
52주 고점 효과, 복권형 주식 효과, 거래량 효과, 계절성)과 실무에서 널리 쓰는 기술적 신호.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class Cond:
    id: str
    name: str
    group: str
    frame: pd.DataFrame  # 날짜 × 종목 불리언
    desc: str = ""


# 그룹 이름 → '하나만 선택' 여부
GROUPS = {
    "단기 가격": False,
    "모멘텀·반전": False,
    "추세": False,
    "과열·침체": False,
    "변동성": False,
    "거래량": False,
    "시장 상황": False,
    "달력·월": True,
    "달력·요일": True,
    "달력·시기": False,
    "시장 구분": True,
    "규모·가격": False,
    "업종": True,
}


def _run_length(mask: pd.DataFrame) -> pd.DataFrame:
    """연속으로 True인 일수."""
    a = mask.to_numpy()
    out = np.zeros(a.shape, dtype=np.int16)
    run = np.zeros(a.shape[1], dtype=np.int16)
    for i in range(a.shape[0]):
        run = np.where(a[i], run + 1, 0).astype(np.int16)
        out[i] = run
    return pd.DataFrame(out, index=mask.index, columns=mask.columns)


def _rsi(close: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def build_conditions(P: dict, info: pd.DataFrame, index: pd.DataFrame, universe: pd.DataFrame | None = None) -> list[Cond]:
    """P: {'O','H','L','C','V','AMT'} 날짜×종목 표. info: code별 market/industry.
    universe: 순위 계산에 포함할 종목(날짜×종목 불리언, 거래대금 기준 통과). 없으면 전체."""
    C, O, H, L, V = P["C"], P["O"], P["H"], P["L"], P["V"]
    dates, codes = C.index, C.columns
    conds: list[Cond] = []
    U = universe if universe is not None else C.notna()

    def add(cid, name, group, frame, desc=""):
        f = frame.reindex(index=dates, columns=codes).fillna(False).astype(bool)
        conds.append(Cond(cid, name, group, f, desc))

    def bcast(series: pd.Series) -> pd.DataFrame:
        v = series.reindex(dates).fillna(False).to_numpy(dtype=bool)
        return pd.DataFrame(np.repeat(v[:, None], len(codes), axis=1), index=dates, columns=codes)

    def per_code(mask_by_code: pd.Series) -> pd.DataFrame:
        v = mask_by_code.reindex(codes).fillna(False).to_numpy(dtype=bool)
        return pd.DataFrame(np.repeat(v[None, :], len(dates), axis=0), index=dates, columns=codes)

    def xrank(x: pd.DataFrame) -> pd.DataFrame:
        """같은 날 거래 가능한 종목들 사이의 백분위 순위(0~1)."""
        return x.where(U).rank(axis=1, pct=True)

    prev = C.shift(1)
    ret1 = C / prev - 1
    run_dn = _run_length(C < prev)
    run_up = _run_length(C > prev)

    ma = {n: C.rolling(n, min_periods=n).mean() for n in (5, 20, 60, 120)}
    sd20 = C.rolling(20, min_periods=20).std()
    hi252 = H.rolling(252, min_periods=200).max()
    lo252 = L.rolling(252, min_periods=200).min()
    hi20p = H.rolling(20, min_periods=20).max().shift(1)
    vavg20 = V.rolling(20, min_periods=20).mean().shift(1)
    rsi = _rsi(C)

    # ── 단기 가격 패턴 ──
    add("dn3", "3거래일 연속 하락", "단기 가격", run_dn == 3, "오늘이 정확히 3일째 하락. 단기 과매도 후 반등을 노리는 대표 규칙")
    add("dn5p", "5거래일 이상 연속 하락", "단기 가격", run_dn >= 5)
    add("up3", "3거래일 연속 상승", "단기 가격", run_up == 3)
    add("up5p", "5거래일 이상 연속 상승", "단기 가격", run_up >= 5)
    add("drop5", "하루 -5% 이상 급락", "단기 가격", ret1 <= -0.05)
    add("drop10", "하루 -10% 이상 폭락", "단기 가격", ret1 <= -0.10)
    add("jump5", "하루 +5% 이상 급등", "단기 가격", ret1 >= 0.05)
    add("limitup", "상한가 근처 마감(+25% 이상)", "단기 가격", ret1 >= 0.25)
    add("gapdn", "갭하락 출발(시가 -2% 이하)", "단기 가격", O / prev - 1 <= -0.02)
    add("gapup", "갭상승 출발(시가 +2% 이상)", "단기 가격", O / prev - 1 >= 0.02)
    add("longlow", "긴 아래꼬리(장중 급락 후 회복)", "단기 가격",
        ((np.minimum(O, C) - L) > 2 * (O - C).abs()) & ((H - L) / prev > 0.03), "매수세가 저가를 받쳐 준 모양")
    add("longup", "긴 위꼬리(장중 급등 후 밀림)", "단기 가격",
        ((H - np.maximum(O, C)) > 2 * (O - C).abs()) & ((H - L) / prev > 0.03))
    add("bigbull", "장대양봉(시가 대비 +5% 이상 마감)", "단기 가격", C / O - 1 >= 0.05)

    # ── 모멘텀·반전(같은 날 다른 종목들과 비교한 순위) ──
    r5, r20 = C / C.shift(5) - 1, C / C.shift(20) - 1
    r120 = C.shift(20) / C.shift(140) - 1      # 6개월 수익률(최근 1달 제외)
    r250 = C.shift(20) / C.shift(250) - 1      # 12개월 수익률(최근 1달 제외)
    q5, q20, q120, q250 = xrank(r5), xrank(r20), xrank(r120), xrank(r250)
    add("rev5lo", "1주 수익률 하위 10%(단기 낙폭과대)", "모멘텀·반전", q5 <= 0.1, "단기 반전 효과: 최근 많이 빠진 종목의 되돌림")
    add("rev5hi", "1주 수익률 상위 10%", "모멘텀·반전", q5 >= 0.9)
    add("rev20lo", "1달 수익률 하위 10%", "모멘텀·반전", q20 <= 0.1, "1개월 반전 효과")
    add("rev20hi", "1달 수익률 상위 10%", "모멘텀·반전", q20 >= 0.9)
    add("mom6hi", "6개월 모멘텀 상위 20%", "모멘텀·반전", q120 >= 0.8, "최근 1달을 뺀 6개월 수익률. 오른 종목이 더 오르는 경향")
    add("mom6lo", "6개월 모멘텀 하위 20%", "모멘텀·반전", q120 <= 0.2)
    add("mom12hi", "12개월 모멘텀 상위 20%", "모멘텀·반전", q250 >= 0.8, "가장 널리 검증된 모멘텀 지표(12-1개월)")
    add("mom12lo", "12개월 모멘텀 하위 20%", "모멘텀·반전", q250 <= 0.2)
    ks, kq = (index[c].reindex(dates).ffill() for c in ("KOSPI", "KOSDAQ"))
    mkt_of = info.set_index("code")["market"].reindex(codes)
    is_ks = per_code(mkt_of == "KOSPI")

    def by_market(fk: pd.Series, fq: pd.Series) -> pd.DataFrame:
        """종목이 속한 시장의 지수 값(또는 조건)을 적용."""
        a = np.where(is_ks.to_numpy(), fk.reindex(dates).to_numpy()[:, None], fq.reindex(dates).to_numpy()[:, None])
        return pd.DataFrame(a, index=dates, columns=codes)

    mret20 = by_market(ks / ks.shift(20) - 1, kq / kq.shift(20) - 1).astype(float)
    add("rshi", "1달간 소속 지수보다 10%p 이상 강세", "모멘텀·반전", r20 - mret20 >= 0.10, "상대강도")
    add("rslo", "1달간 소속 지수보다 10%p 이상 약세", "모멘텀·반전", r20 - mret20 <= -0.10)

    # ── 추세(이동평균선·신고가) ──
    add("below20", "20일 이동평균선 아래", "추세", C < ma[20])
    add("above20", "20일 이동평균선 위", "추세", C > ma[20])
    add("below60", "60일 이동평균선 아래", "추세", C < ma[60])
    add("above60", "60일 이동평균선 위", "추세", C > ma[60])
    add("below120", "120일 이동평균선 아래", "추세", C < ma[120])
    add("above120", "120일 이동평균선 위", "추세", C > ma[120])
    add("ma60up", "60일선이 상승 중(20일 전보다 높음)", "추세", ma[60] > ma[60].shift(20))
    add("ma60dn", "60일선이 하락 중", "추세", ma[60] < ma[60].shift(20))
    add("gc5_20", "골든크로스(5일선이 20일선 돌파)", "추세", (ma[5] > ma[20]) & (ma[5].shift(1) <= ma[20].shift(1)))
    add("dc5_20", "데드크로스(5일선이 20일선 하향)", "추세", (ma[5] < ma[20]) & (ma[5].shift(1) >= ma[20].shift(1)))
    add("gc20_60", "골든크로스(20일선이 60일선 돌파)", "추세", (ma[20] > ma[60]) & (ma[20].shift(1) <= ma[60].shift(1)))
    add("aligned", "정배열(5>20>60>120일선)", "추세", (ma[5] > ma[20]) & (ma[20] > ma[60]) & (ma[60] > ma[120]))
    add("reverse", "역배열(5<20<60<120일선)", "추세", (ma[5] < ma[20]) & (ma[20] < ma[60]) & (ma[60] < ma[120]))
    add("disp90", "20일 이격도 90% 이하", "추세", C < ma[20] * 0.90, "주가가 20일선보다 10% 이상 아래")
    add("disp110", "20일 이격도 110% 이상", "추세", C > ma[20] * 1.10)
    add("near52h", "52주 신고가 근처(5% 이내)", "추세", C >= hi252 * 0.95, "52주 고점 효과: 고점 근처 종목이 계속 강한 경향")
    add("new52h", "오늘 52주 신고가 경신", "추세", H >= hi252)
    add("near52l", "52주 신저가 근처(5% 이내)", "추세", C <= lo252 * 1.05)
    add("dd30", "52주 고점 대비 -30% 이상 하락", "추세", C <= hi252 * 0.70)
    add("dd50", "52주 고점 대비 -50% 이상 하락", "추세", C <= hi252 * 0.50)
    add("brk20", "20일 박스권 돌파 + 거래량 증가", "추세", (C > hi20p) & (V >= 1.5 * vavg20), "최근 20일 최고가를 거래량과 함께 넘어섬")

    # ── 과열·침체 ──
    add("rsi30", "RSI 30 이하(과매도)", "과열·침체", rsi <= 30)
    add("rsi20", "RSI 20 이하(극단적 과매도)", "과열·침체", rsi <= 20)
    add("rsi70", "RSI 70 이상(과매수)", "과열·침체", rsi >= 70)
    add("bbl", "볼린저밴드 하단 이탈", "과열·침체", C < ma[20] - 2 * sd20)
    add("bbu", "볼린저밴드 상단 돌파", "과열·침체", C > ma[20] + 2 * sd20)
    bw = (4 * sd20 / ma[20])
    add("squeeze", "볼린저밴드 수축(변동성 최저 구간)", "과열·침체",
        bw <= bw.rolling(120, min_periods=100).quantile(0.1), "에너지가 모인 뒤 크게 움직이는 경향")
    low14, high14 = L.rolling(14, min_periods=14).min(), H.rolling(14, min_periods=14).max()
    k = 100 * (C - low14) / (high14 - low14).replace(0, np.nan)
    kd = k.rolling(3).mean()
    add("stoch20", "스토캐스틱 20 이하에서 상향(과매도 탈출)", "과열·침체", (k < 25) & (k > kd) & (k.shift(1) <= kd.shift(1)))
    ema12, ema26 = C.ewm(span=12, adjust=False).mean(), C.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    sig = macd.ewm(span=9, adjust=False).mean()
    add("macdgc", "MACD 골든크로스(시그널선 상향 돌파)", "과열·침체", (macd > sig) & (macd.shift(1) <= sig.shift(1)))
    add("macdgc0", "MACD 0선 아래에서 골든크로스", "과열·침체", (macd > sig) & (macd.shift(1) <= sig.shift(1)) & (macd < 0))

    # ── 변동성 ──
    vol60 = ret1.rolling(60, min_periods=50).std()
    qv = xrank(vol60)
    add("lowvol", "저변동성(60일 변동성 하위 20%)", "변동성", qv <= 0.2, "저변동성 효과: 덜 출렁이는 종목이 위험 대비 성과가 좋은 경향")
    add("highvol", "고변동성(60일 변동성 상위 20%)", "변동성", qv >= 0.8)
    mx20 = ret1.rolling(20, min_periods=20).max()
    add("lottery", "복권형(최근 20일 중 하루 +15% 이상 급등 이력)", "변동성", mx20 >= 0.15,
        "복권형 주식 효과: 하루 급등 이력이 있는 종목은 이후 부진한 경향")
    add("calm", "조용한 종목(최근 20일 일간 등락 ±3% 이내)", "변동성", ret1.abs().rolling(20, min_periods=20).max() <= 0.03)

    # ── 거래량 ──
    add("vol2x", "거래량 급증(20일 평균의 2배 이상)", "거래량", V >= 2 * vavg20)
    add("vol5x", "거래량 폭증(20일 평균의 5배 이상)", "거래량", V >= 5 * vavg20)
    add("volhalf", "거래량 급감(20일 평균의 절반 이하)", "거래량", V <= 0.5 * vavg20)
    vr = V.rolling(5).mean() / V.rolling(60, min_periods=60).mean()
    add("voldry", "거래 소강(5일 평균이 60일 평균의 50% 이하)", "거래량", vr <= 0.5, "관심이 식은 상태")
    add("upvol", "거래량 실린 상승(+3% & 거래량 2배)", "거래량", (ret1 >= 0.03) & (V >= 2 * vavg20))
    add("dnvol", "거래량 실린 하락(-3% & 거래량 2배)", "거래량", (ret1 <= -0.03) & (V >= 2 * vavg20))
    add("dnquiet", "거래량 없는 하락(-3% & 거래량 평균 이하)", "거래량", (ret1 <= -0.03) & (V <= vavg20), "매도세가 약한 하락")

    # ── 시장 상황(소속 지수 기준) ──
    def mk(fk, fq):
        return by_market(fk.astype(float), fq.astype(float)) > 0.5

    add("mkt_up", "소속 지수가 20일선 위", "시장 상황", mk(ks > ks.rolling(20).mean(), kq > kq.rolling(20).mean()))
    add("mkt_dn", "소속 지수가 20일선 아래", "시장 상황", mk(ks < ks.rolling(20).mean(), kq < kq.rolling(20).mean()))
    add("mkt_bull", "소속 지수가 120일선 위(강세장)", "시장 상황", mk(ks > ks.rolling(120).mean(), kq > kq.rolling(120).mean()))
    add("mkt_bear", "소속 지수가 120일선 아래(약세장)", "시장 상황", mk(ks < ks.rolling(120).mean(), kq < kq.rolling(120).mean()))
    add("mkt_dn3", "소속 지수 3일 연속 하락", "시장 상황",
        mk(_run_length((ks < ks.shift(1)).to_frame()).iloc[:, 0] >= 3, _run_length((kq < kq.shift(1)).to_frame()).iloc[:, 0] >= 3))
    add("mkt_drop2", "소속 지수 하루 -2% 이상 하락", "시장 상황", mk(ks / ks.shift(1) - 1 <= -0.02, kq / kq.shift(1) - 1 <= -0.02))
    add("mkt_jump2", "소속 지수 하루 +2% 이상 상승", "시장 상황", mk(ks / ks.shift(1) - 1 >= 0.02, kq / kq.shift(1) - 1 >= 0.02))

    def hv(s):
        v = (s / s.shift(1) - 1).rolling(20).std()
        return v >= v.rolling(250, min_periods=200).quantile(0.8)

    add("mkt_fear", "시장 변동성 높음(지수 20일 변동성 상위 20%)", "시장 상황", mk(hv(ks), hv(kq)), "공포 구간")

    # ── 달력 ──
    d = pd.Series(dates, index=dates)
    for m in range(1, 13):
        add(f"m{m:02d}", f"{m}월", "달력·월", bcast(d.dt.month == m), "신호일이 이 달에 속함")
    for i, nm in enumerate(["월", "화", "수", "목", "금"]):
        add(f"wd{i}", f"{nm}요일", "달력·요일", bcast(d.dt.dayofweek == i))
    ym = d.dt.to_period("M")
    nth = d.groupby(ym).cumcount()
    left = d.groupby(ym).cumcount(ascending=False)
    add("mstart", "월초(첫 3거래일)", "달력·시기", bcast(nth < 3))
    # 월말은 '이번 달에 남은 거래일'이 필요하다. 마지막 날짜(오늘)도 판정할 수 있게 달력 기준 평일로 계산
    bd_left = pd.Series([np.busday_count(x.date() + pd.Timedelta(days=1), (x + pd.offsets.MonthEnd(0)).date() + pd.Timedelta(days=1))
                         for x in dates], index=dates)
    add("mend", "월말(마지막 3평일)", "달력·시기", bcast(bd_left < 3))
    add("dec_late", "연말(12월 15일 이후)", "달력·시기", bcast((d.dt.month == 12) & (d.dt.day >= 15)), "배당·연말 효과")
    add("jan_early", "연초(1월 첫 10거래일)", "달력·시기", bcast((d.dt.month == 1) & (nth < 10)), "1월 효과(특히 소형주)")
    dom = d.dt.day
    wk2thu = (d.dt.dayofweek <= 3) & (dom >= 8) & (dom <= 14) & ((dom - d.dt.dayofweek + 3) >= 8) & ((dom - d.dt.dayofweek + 3) <= 14)
    add("optexp", "옵션만기 주간(둘째 목요일 이전)", "달력·시기", bcast(wk2thu))

    # ── 시장 구분·규모·가격 ──
    add("ks", "코스피 종목", "시장 구분", is_ks)
    add("kq", "코스닥 종목", "시장 구분", ~is_ks)
    amt20 = P["AMT"].rolling(20, min_periods=20).mean()
    qa = xrank(amt20)
    add("big", "거래대금 상위 20%(대형·인기주)", "규모·가격", qa >= 0.8)
    add("small", "거래대금 하위 30%(소형·소외주)", "규모·가격", qa <= 0.3)
    add("lowpx", "저가주(주가 2,000원 미만)", "규모·가격", C < 2000)
    add("highpx", "고가주(주가 10만 원 이상)", "규모·가격", C >= 100000)

    # ── 업종: 종목 수가 충분한 업종만 ──
    ind = info.set_index("code")["industry"].reindex(codes)
    counts = ind.value_counts()
    for nm, cnt in counts.items():
        if cnt < 25 or nm == "기타":
            continue
        # 업종 id는 이름에서 만든다(종목 목록이 바뀌어도 같은 업종은 같은 id)
        add("ind_" + hashlib.md5(nm.encode("utf-8")).hexdigest()[:6], f"업종: {nm}", "업종", per_code(ind == nm))

    return conds
