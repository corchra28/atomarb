"""How wide is the band on a census of N blocks? Bootstrap from every circuit observed."""
import json, random, sys
random.seed(7)
pool, blocks = [], 0
for p in sys.argv[1:]:
    d = json.load(open(p))
    blocks += d['summary']['blocksRead']
    pool += [a['netLamports'] for a in d['arbs'] if a['mintsTouched'] >= 2]
rate = len(pool) / blocks
print(f'{len(pool)} circuits over {blocks} blocks ({rate:.2f}/block)')
print(f"{'blocks':>9}{'p05/med':>10}{'p95/med':>10}{'band':>9}")
for nblk in (120, 300, 1000, 3000, 10000, 30000):
    n = int(rate * nblk)
    sums = sorted(sum(random.choice(pool) for _ in range(n)) for _ in range(400))
    med, p05, p95 = sums[len(sums)//2], sums[int(len(sums)*.05)], sums[int(len(sums)*.95)]
    print(f'{nblk:>9,}{p05/med:>10.2f}{p95/med:>10.2f}{p95/p05:>8.1f}x')
