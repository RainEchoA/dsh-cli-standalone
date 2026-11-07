// 4K random IOPS benchmark for the npm-install slowness investigation.
// Usage: node iops-bench.mjs <path> [sizeGB]
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const target = process.argv[2] ?? path.join(os.tmpdir(), 'iops-test.dat')
const sizeGB = Number(process.argv[3] ?? 4)
const SIZE = BigInt(sizeGB) * 1024n ** 3n
const BS = 4096
const DURATION_MS = 8000

const bufW = Buffer.alloc(BS, 0xAB)
const bufR = Buffer.alloc(BS)
const offsets = new Set()

function randOffset() {
  // 4K-aligned within [0, SIZE-BS]
  return BigInt(Math.floor(Math.random() * (Number(SIZE / BigInt(BS)) - 1))) * BigInt(BS)
}

async function phase(name, { write = false, qd = 1, seconds = DURATION_MS / 1000, sequential = false }) {
  const fh = await fs.open(target, write ? 'r+' : 'r')
  const deadline = Date.now() + seconds * 1000
  let ops = 0n
  let latTotalNs = 0n
  const errors = new Map()
  const seqOff = new Array(qd).fill(0n).map((_, i) => BigInt(i) * BigInt(BS) * 256n)

  async function worker(id) {
    while (Date.now() < deadline) {
      let off
      if (sequential) {
        off = seqOff[id]
        seqOff[id] = (seqOff[id] + BigInt(BS) * BigInt(qd)) % (SIZE - BigInt(BS))
      } else {
        off = randOffset()
      }
      const t0 = process.hrtime.bigint()
      try {
        if (write) await fh.write(bufW, 0, BS, off)
        else await fh.read(bufR, 0, BS, off)
        latTotalNs += process.hrtime.bigint() - t0
        ops++
      } catch (e) {
        errors.set(e.code ?? String(e), (errors.get(e.code ?? String(e)) ?? 0) + 1)
      }
    }
  }
  await Promise.all(Array.from({ length: qd }, (_, i) => worker(i)))
  await fh.close()

  const iops = Number(ops) / seconds
  const latMs = ops > 0n ? Number(latTotalNs / ops) / 1e6 : NaN
  const bw = (iops * BS) / 1024 / 1024
  console.log(
    `${name.padEnd(22)} ${iops.toFixed(0).padStart(8)} IOPS  ${bw.toFixed(1).padStart(7)} MB/s  avg_lat ${latMs.toFixed(2).padStart(7)} ms` +
      (errors.size ? `   errors: ${[...errors.entries()].map(([k, v]) => `${k}×${v}`).join(',')}` : ''),
  )
  return iops
}

console.log(`target=${target}  size=${sizeGB}GB  bs=${BS}B  phase=${DURATION_MS / 1000}s`)
// preallocate
{
  const fh = await fs.open(target, 'w')
  await fh.truncate(Number(SIZE))
  await fh.close()
}

await phase('seq write 4K QD=1', { write: true, qd: 1, seconds: 4, sequential: true })
await phase('rand read  QD=1', { write: false, qd: 1 })
await phase('rand write QD=1', { write: true, qd: 1 })
await phase('rand read  QD=32', { write: false, qd: 32 })
await phase('rand write QD=32', { write: true, qd: 32 })

// metadata: small file create+delete (what npm reify does)
{
  const dir = target + '.d'
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const N = 1000
  let t0 = Date.now()
  for (let i = 0; i < N; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), 'x')
  const createMs = Date.now() - t0
  t0 = Date.now()
  for (let i = 0; i < N; i++) await fs.rm(path.join(dir, `f${i}.txt`))
  const deleteMs = Date.now() - t0
  await fs.rm(dir, { recursive: true, force: true })
  console.log(`small-file create      ${((N / createMs) * 1000).toFixed(0).padStart(8)} files/s   (1000 × 1KiB, ${createMs} ms)`)
  console.log(`small-file delete      ${((N / deleteMs) * 1000).toFixed(0).padStart(8)} files/s   (1000 files, ${deleteMs} ms)`)
}

await fs.rm(target, { force: true })
console.log('done.')
