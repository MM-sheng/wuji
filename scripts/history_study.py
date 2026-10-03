#!/usr/bin/env python3
"""WUJI over Bitcoin's whole history: recompute the index from every header since genesis and test it.

    python3 scripts/history_study.py HEADERS.bin PRICES_DIR OUT.json

HEADERS.bin: raw 80-byte Bitcoin headers from height 0, concatenated (the P2P client's
indexer/data/headers/mainnet.bin). PRICES_DIR: Binance daily closes as JSON [[unix_seconds, close], ...]
named BTCUSDT.json, ETHUSDT.json, PAXGUSDT.json. Everything printed is recomputable from those inputs.
"""
import hashlib, json, math, sys, time
from datetime import datetime, timezone
import numpy as np
from scipy import stats

UNIT = 1.2e-5
MEAN = 4080
VAR = 32 * (256 ** 2 - 1) / 12  # variance of a sum of 32 uniform bytes = 174,760
SD = math.sqrt(VAR)


def load_headers(path):
    raw = open(path, 'rb').read()
    n = len(raw) // 80
    d = np.empty(n, dtype=np.int32)       # byteSum(sha256(sha256d(header))) - 4080, the index increment
    plain = np.empty(n, dtype=np.int32)   # byteSum(sha256d(header)) - 4080, WITHOUT the extra hash
    ts = np.empty(n, dtype=np.int64)
    prev = b'\x00' * 32
    for i in range(n):
        h = raw[i * 80:(i + 1) * 80]
        assert h[4:36] == prev, f'linkage break at {i}'
        digest = hashlib.sha256(hashlib.sha256(h).digest()).digest()
        prev = digest
        d[i] = sum(hashlib.sha256(digest).digest()) - MEAN
        plain[i] = sum(digest) - MEAN
        ts[i] = int.from_bytes(h[68:72], 'little')
    return d, plain, ts


def exact_pmf():
    """Exact distribution of a sum of 32 independent uniform bytes."""
    p = np.ones(256) / 256
    out = np.array([1.0])
    for _ in range(32):
        out = np.convolve(out, p)
    return out  # index k = sum k, 0..8160


def gof(d):
    pmf = exact_pmf()
    sums = d + MEAN
    counts = np.bincount(sums, minlength=len(pmf)).astype(float)
    expected = pmf * len(d)
    # bins of width 20 around the centre, tails pooled so every expected count is >= 5
    edges = [0] + list(range(MEAN - 2000, MEAN + 2001, 20)) + [len(pmf)]
    obs = np.add.reduceat(counts, edges[:-1])
    exp = np.add.reduceat(expected, edges[:-1])
    keep = exp >= 5
    o, e = obs[keep], exp[keep]
    o_tail, e_tail = obs[~keep].sum(), exp[~keep].sum()
    if e_tail > 0:
        o, e = np.append(o, o_tail), np.append(e, e_tail)
    e = e * o.sum() / e.sum()
    chi2, p = stats.chisquare(o, e)
    return {'bins': int(len(o)), 'chi2': float(chi2), 'p': float(p)}


def acf(x, lags):
    x = x - x.mean()
    v = (x * x).sum()
    return [float((x[:-k] * x[k:]).sum() / v) for k in range(1, lags + 1)]


def ljung_box(r, n):
    q = n * (n + 2) * sum(rk * rk / (n - k) for k, rk in enumerate(r, start=1))
    return float(q), float(stats.chi2.sf(q, len(r)))


def runs_test(x):
    s = x > 0
    s = s[x != 0]
    n1, n2 = int(s.sum()), int((~s).sum())
    runs = 1 + int((s[1:] != s[:-1]).sum())
    mu = 2 * n1 * n2 / (n1 + n2) + 1
    var = 2 * n1 * n2 * (2 * n1 * n2 - n1 - n2) / ((n1 + n2) ** 2 * (n1 + n2 - 1))
    z = (runs - mu) / math.sqrt(var)
    return {'runs': runs, 'expected': mu, 'z': z, 'p': float(2 * stats.norm.sf(abs(z)))}


def daily_path(U, ts):
    """S at the last block of each UTC day (by header timestamp, processed in height order)."""
    days = ts // 86400
    out = {}
    for i in range(len(U)):
        out[int(days[i])] = float(U[i] * UNIT)  # later heights overwrite: end-of-day value
    keys = sorted(out)
    return keys, np.array([out[k] for k in keys])


def returns_by_day(path):
    k = json.load(open(path))
    day = {int(t // 86400): c for t, c in k}
    keys = sorted(day)
    return {keys[i]: math.log(day[keys[i]] / day[keys[i - 1]]) for i in range(1, len(keys)) if keys[i] == keys[i - 1] + 1}


def corr_block(dS, other, lag=0):
    xs, ys = [], []
    for day, r in other.items():
        if day - lag in dS:
            xs.append(dS[day - lag]); ys.append(r)
    xs, ys = np.array(xs), np.array(ys)
    pr, pp = stats.pearsonr(xs, ys)
    sr, sp = stats.spearmanr(xs, ys)
    ar, ap = stats.pearsonr(np.abs(xs), np.abs(ys))
    return {'n': int(len(xs)), 'pearson': float(pr), 'pearson_p': float(pp), 'spearman': float(sr),
            'spearman_p': float(sp), 'abs_pearson': float(ar), 'abs_pearson_p': float(ap)}


def main(headers, prices, out):
    t0 = time.time()
    d, plain, ts = load_headers(headers)
    n = len(d)
    U = np.cumsum(d.astype(np.int64))
    res = {'headers': n, 'tip_height': n - 1, 'computed_at': datetime.now(timezone.utc).isoformat()}

    # Cross-check with the repository's fixture: heights 798336..804395 sum to U = 6888 (WujiIndex.real.t.sol).
    fixture_sum = int(d[798336:798336 + 6060].sum())
    res['fixture_check'] = {'heights': '798336..804395', 'sum': fixture_sum, 'expected': 6888, 'ok': fixture_sum == 6888}

    res['increments'] = {
        'mean': float(d.mean()), 'mean_z': float(d.mean() / (SD / math.sqrt(n))),
        'sd': float(d.std(ddof=1)), 'sd_theory': SD,
        'var_ratio': float(d.var(ddof=1) / VAR),
        'var_z': float((d.var(ddof=1) / VAR - 1) / math.sqrt(2 / (n - 1) + (stats.kurtosis(d, fisher=True)) / n)),
        'min': int(d.min()), 'max': int(d.max()),
        'skew': float(stats.skew(d)), 'excess_kurtosis': float(stats.kurtosis(d)),
        'gof_exact': gof(d),
    }
    r = acf(d.astype(float), 20)
    q, qp = ljung_box(r, n)
    res['independence'] = {'acf_1_to_5': r[:5], 'acf_max_abs_1_20': float(max(abs(x) for x in r)),
                           'acf_bound_95': 1.96 / math.sqrt(n), 'ljung_box_20': q, 'ljung_box_p': qp,
                           'runs': runs_test(d)}

    years = np.array([datetime.fromtimestamp(int(t), timezone.utc).year for t in ts])
    by_year = {}
    for y in sorted(set(years.tolist())):
        x = d[years == y]
        by_year[str(y)] = {'blocks': int(len(x)), 'mean_z': float(x.mean() / (SD / math.sqrt(len(x)))),
                           'var_ratio': float(x.var(ddof=1) / VAR)}
    res['by_year'] = by_year
    res['max_abs_year_mean_z'] = float(max(abs(v['mean_z']) for v in by_year.values()))

    res['without_extra_hash'] = {'mean': float(plain.mean()), 'mean_z': float(plain.mean() / (SD / math.sqrt(n))),
                                 'note': 'byteSum of the block hash itself: proof of work forces leading zero bytes'}

    days, S = daily_path(U, ts)
    dS = {days[i]: S[i] - S[i - 1] for i in range(1, len(days)) if days[i] == days[i - 1] + 1}
    peak, mdd = -1e9, 0.0
    for s in S:
        peak = max(peak, s); mdd = min(mdd, s - peak)
    dvals = np.array(list(dS.values()))
    res['path'] = {
        'S_final': float(U[-1] * UNIT), 'S_min': float(S.min()), 'S_max': float(S.max()),
        'level_final_100e^S': float(100 * math.exp(U[-1] * UNIT)),
        'daily_sd': float(dvals.std(ddof=1)), 'annual_vol_from_daily': float(dvals.std(ddof=1) * math.sqrt(365.25)),
        'annual_vol_theory': UNIT * SD * math.sqrt(144 * 365.25),
        'max_drawdown_log': float(mdd), 'max_drawdown_pct': float(100 * (1 - math.exp(mdd))),
        'first_day': datetime.fromtimestamp(days[0] * 86400, timezone.utc).date().isoformat(),
        'last_day': datetime.fromtimestamp(days[-1] * 86400, timezone.utc).date().isoformat(),
    }
    res['daily_S'] = [[datetime.fromtimestamp(k * 86400, timezone.utc).date().isoformat(), round(v, 6)] for k, v in zip(days, S)]

    res['correlation'] = {}
    for sym in ['BTCUSDT', 'ETHUSDT', 'PAXGUSDT']:
        other = returns_by_day(f'{prices}/{sym}.json')
        res['correlation'][sym] = {'same_day': corr_block(dS, other, 0), 'wuji_leads_1d': corr_block(dS, other, 1),
                                   'wuji_lags_1d': corr_block(dS, other, -1)}
        # rolling 365-day correlation, to show its spread over time
        ks = sorted(k for k in other if k in dS)
        roll = []
        for i in range(365, len(ks), 30):
            w = ks[i - 365:i]
            roll.append(float(np.corrcoef([dS[k] for k in w], [other[k] for k in w])[0, 1]))
        res['correlation'][sym]['rolling_365d'] = {'min': min(roll), 'max': max(roll), 'n_windows': len(roll),
                                                   'bound_95': 1.96 / math.sqrt(365)}
    res['seconds'] = time.time() - t0
    json.dump(res, open(out, 'w'), indent=1)
    summary = {k: v for k, v in res.items() if k not in ('daily_S', 'by_year')}
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main(*sys.argv[1:4])
