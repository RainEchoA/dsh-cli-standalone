#!/usr/bin/env node
// Print the @deepseek-ai/dsh versions npm currently serves on its `latest` and `next`
// dist-tags, excluding dev/alpha prereleases. `latest` is what `npm i @deepseek-ai/dsh`
// installs; `next` is what `npm i @deepseek-ai/dsh@next` installs. When the `latest`
// dist-tag is missing or points at an excluded version, it falls back to the newest
// eligible published version; a missing/invalid `next` dist-tag yields next=null.
// Stability and prerelease ordering follow semver: 0.2.2 > 0.2.2-rc.1 > 0.2.2-alpha.3 > 0.2.2-dev.1.
//
// Usage:
//   node scripts/scan-latest-version.mjs          # prints the `latest` channel version
//   node scripts/scan-latest-version.mjs --json   # prints {"latest":"...","next":"..."|null}
const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
if (args.length > 1 || (args.length === 1 && !jsonMode)) {
  console.error('Usage: node scripts/scan-latest-version.mjs [--json]')
  process.exit(2)
}

const response = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } })
if (!response.ok) throw new Error(`npm registry request failed: HTTP ${response.status} for ${REGISTRY_URL}`)
const { versions, 'dist-tags': distTags = {} } = await response.json()

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

let newest = eligible[0]
for (const candidate of eligible.slice(1)) {
  if (compareSemver(candidate.parsed, newest.parsed) > 0) newest = candidate
}

// A dist-tag only counts when it points at a published, eligible version.
const channel = (tag) => {
  const version = distTags?.[tag]
  if (!version || !eligible.some((entry) => entry.version === version)) return null
  return version
}

const latest = channel('latest') ?? newest.version
const nextTag = channel('next')
const next = nextTag && nextTag !== latest ? nextTag : null

console.error(`scan-latest-version: published=${Object.keys(versions).length} eligible=${eligible.length} excluded(dev/alpha)=${excluded.length} latest=${latest} next=${next ?? '(none)'}`)
if (jsonMode) console.log(JSON.stringify({ latest, next }))
else console.log(latest)

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
