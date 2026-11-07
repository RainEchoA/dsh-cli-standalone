// Part 2: cold-cache read IOPS (file >> RAM) + directory enumeration (the npm pain).
// Usage: node iops-bench2.mjs <workdir>
import fs from 'node:fs/promises'
import path from 'node:path'

const work = process.argv[2] ?? '.'
const BS = 4096
const bigFile = path.join(work, 'big.dat')
const BIG = 24n * 1024n ** 3n // 24GB > 16GB RAM

// --- 1) dir enumeration: 5000 files in ONE dir, readdir+stat each ---
{
  const dir = path.join(work, 'enum.d')
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  for (let i = 0; i < 5000; i++) await fs.writeFile(path.join(dir, `pkg-${i}.json`), '{}')
  // warm the dir entries, then time repeated walks
  for (let r = 0; r < 2; r++) {
    const t0 = Date.now()
    const names = await fs.readdir(dir)
    let n = 0
    for (const name of names) {
      const st = await fs.stat(path.join(dir, name))
      if (st.size >= 0) n++
    }
    console.log(`readdir+stat 5000 files (warm)  ${((n / (Date.now() - t0)) * 1000).toFixed(0).padStart(7)} files/s  (${Date.now() - t0} ms)`)
  }
  await fs.rm(dir, { recursive: true, force: true })
}

// --- 2) cold sequential read bandwidth over 24GB (1MiB reads) ---
{
  const fh = await fs.open(bigFile, 'w')
  await fh.truncate(Number(BIG))
  await fh.close()
  const fh2 = await fs.open(bigFile, 'r')
  const buf = Buffer.alloc(1024 * 1024)
  let bytes = 0n
  const t0 = Date.now()
  while (bytes < BIG) {
    const { bytesRead } = await fh2.read(buf, 0, buf.length, bytes)
    if (bytesRead === 0) break
    bytes += BigInt(bytesRead)
    if (bytes > 8n * 1024n ** 3n && bytes % (4n * 1024n ** 3n) < 1024n * 1024n) {
      const s = (Date.now() - t0) / 1000
      console.log(`  … ${(Number(bytes) / 1024 ** 3).toFixed(0)} GB read, ${(Number(bytes) / 1024 ** 2 / s).toFixed(0)} MB/s`)
    }
  }
  const s = (Date.now() - t0) / 1000
  console.log(`seq read 24GB (1MiB)  ${(Number(bytes) / 1024 ** 2 / s).toFixed(0).padStart(8)} MB/s   (${s.toFixed(1)} s)`)
  await fh2.close()
}

// --- 3) random 4K read QD=32 on 24GB, 15s (mostly cache miss) ---
{
  const fh = await fs.open(bigFile, 'r')
  const buf = Buffer.alloc(BS)
  const maxOff = Number(BIG / BigInt(BS)) - 1
  const deadline = Date.now() + 15000
  let ops = 0n
  async function worker() {
    while (Date.now() < deadline) {
      const off = BigInt(Math.floor(Math.random() * maxOff)) * BigInt(BS)
      await fh.read(buf, 0, BS, off)
      ops++
    }
  }
  await Promise.all(Array.from({ length: 32 }, worker))
  await fh.close()
  console.log(`rand read 4K QD=32 (24GB)  ${(Number(ops) / 15).toFixed(0).padStart(8)} IOPS  (${((Number(ops) / 15) * BS) / 1024 / 1024} MB/s)`)
}

await fs.rm(bigFile, { force: true })
console.log('done.')
