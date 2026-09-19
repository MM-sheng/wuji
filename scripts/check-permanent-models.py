"""Exact accounting counterexamples, not a simulation or proof of deployability."""
from fractions import Fraction as F


def liability(y, n, share, notional=F(100)):
    return notional * (y * share + n * (1 - share))


# A matched pair is backed at every share. Redeeming only its winner destroys that property.
reserve, y, n = F(100), F(1), F(1)
assert all(liability(y, n, F(k, 100)) == reserve for k in range(101))
reserve -= F(90)
y -= 1
assert liability(y, n, F(9, 10)) == reserve
assert liability(y, n, F(1, 10)) == 90
assert reserve == 10
print('Fixed claims: pay YANG 90; reserve 10; later YIN claim 90; deficit 80.')

# Allowing burns only as pairs preserves the all-state reserve bound.
y, n, reserve = F(3), F(3), F(300)
y -= F(1, 2)
n -= F(1, 2)
reserve -= F(50)
assert reserve == 100 * max(y, n)
print('Paired burns: 2.5 YANG + 2.5 YIN remain, backed by 250 in every state.')

# Reweighting to the remaining reserve preserves solvency but changes original claims.
reserve = F(100)
alice_out = F(90)
reserve -= alice_out
bob_max_out = reserve
assert bob_max_out == 10
assert alice_out + bob_max_out == 100
print('Rebased claims: after Alice takes 90, Bob can receive at most 10 without new funding.')

# Waiting-time quantiles for ideal zero-log-drift Brownian price.
from math import log
from statistics import NormalDist

sigma_per_day = 0.06  # illustration only, not a measured chain calibration
a = log(1.10)
for p in (0.5, 0.9, 0.95, 0.99):
    t = (a / (sigma_per_day * NormalDist().inv_cdf(1 - p / 2))) ** 2
    print(f'Ideal +10% first-passage quantile {p:.0%}: {t:.2f} days')
