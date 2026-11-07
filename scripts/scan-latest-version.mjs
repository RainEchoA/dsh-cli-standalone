#!/usr/bin/env node
// Print the newest @deepseek-ai/dsh version published to npm, excluding dev/alpha prereleases.
// Stability and prerelease ordering follow semver: 0.2.2 > 0.2.2-rc.1 > 0.2.2-alpha.3 > 0.2.2-dev.1.
const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'

const response = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } })
if (!response.ok) throw new Error(`npm registry request failed: HTTP ${response.status} for ${REGISTRY_URL}`)
const { versions } = await response.json()

const excluded = []
const eligible = []
for (const version of Object.keys(versions)) {
  const parsed = parse(version)
  if (!parsed) continue
  if (parsed.pre && /^(dev|alpha)$/i.test(parsed.pre[0])) excluded.push(version)
  else eligible.push({ version, parsed })
}

if (eligible.length === 0) {
  console.error(`scan-latest-version: no eligible versions of @deepseek-ai/dsh found among ${Object.keys(versions).length} published`)
  process.exit(1)
}

let latest = eligible[0]
for (const candidate of eligible.slice(1)) {
  if (compareSemver(candidate.parsed, latest.parsed) > 0) latest = candidate
}

console.error(`scan-latest-version: published=${Object.keys(versions).length} eligible=${eligible.length} excluded(dev/alpha)=${excluded.length} latest=${latest.version}`)
console.log(latest.version)

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : null,
  }
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (!a.pre && !b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) - Number(right)
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}
