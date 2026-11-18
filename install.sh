#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [options]

Options:
  --version <dsh-version>   Explicit dsh version; when omitted, the newest release of this
                            repo is resolved automatically (dev/alpha prereleases excluded)
  --archive <file>          Install a local dsh-v<version>-linux-x64.tar.gz; when --version
                            is omitted the version is inferred from the archive file name
  --checksum <sha256>       Expected archive checksum; otherwise read <archive>.sha256;
                            installation proceeds unverified when neither exists
  --prefix <directory>      Installation prefix (default: $HOME/.local)
  --base-url <url>          Release download URL without a trailing slash
  --releases-json-url <url> Release index JSON used for version resolution
  --github-proxy <url>      GitHub acceleration proxy (e.g. https://api.gitproxy.dev);
                            rewrites default GitHub URLs into "<proxy>/<original url>"
  --no-modify-path          Do not append $prefix/bin to $HOME/.profile

Environment: DSH_VERSION, DSH_BASE_URL, DSH_RELEASES_JSON_URL, DSH_GH_PROXY and
DSH_PREFIX are honored when the matching option is not given.

Without --archive, both the archive and its .sha256 file are downloaded from:
  https://github.com/RainEchoA/dsh-cli-standalone/releases/download/v<version>/
EOF
}

fail() {
  echo "install.sh: ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool not found: $1"
}

# Optional GitHub acceleration proxy (e.g. https://gitproxy.dev): rewrites default GitHub
# URLs into "<proxy>/<original url>". Explicit non-GitHub URLs (custom mirrors) pass through.
github_url() {
  if [ -z "$github_proxy" ]; then
    printf '%s' "$1"
    return
  fi
  case $1 in
    http://github.com/*|https://github.com/*|http://raw.githubusercontent.com/*|https://raw.githubusercontent.com/*|http://api.github.com/*|https://api.github.com/*|http://codeload.github.com/*|https://codeload.github.com/*)
      printf '%s/%s' "${github_proxy%/}" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Semver parse/compare + dev/alpha exclusion, mirroring scripts/scan-latest-version.mjs and
# install.ps1 so every entry point resolves the same versions. Prints every eligible version,
# one per line, in descending semver order (newest first) for availability probing.
resolve_latest_awk=$(cat <<'AWK'
function cmp_core(a, b, x, y, i) {
  split(a, x, "."); split(b, y, ".")
  for (i = 1; i <= 3; i++) {
    if (x[i] + 0 != y[i] + 0) return x[i] + 0 < y[i] + 0 ? -1 : 1
  }
  return 0
}
function cmp(a_core, a_pre, a_n, b_core, b_pre, b_n, ap, bp, i, an, bn, anum, bnum, c) {
  c = cmp_core(a_core, b_core); if (c != 0) return c
  if (a_n == 0 && b_n == 0) return 0
  if (a_n == 0) return 1
  if (b_n == 0) return -1
  split(a_pre, ap, "."); split(b_pre, bp, ".")
  for (i = 1; i <= (a_n > b_n ? a_n : b_n); i++) {
    if (i > a_n) return -1
    if (i > b_n) return 1
    an = ap[i]; bn = bp[i]
    anum = (an ~ /^[0-9]+$/); bnum = (bn ~ /^[0-9]+$/)
    if (anum && bnum) { if (an + 0 != bn + 0) return an + 0 < bn + 0 ? -1 : 1 }
    else if (anum != bnum) return anum ? -1 : 1
    else if (an != bn) return an < bn ? -1 : 1
  }
  return 0
}
{
  v = $0
  sub(/^v/, "", v)
  if (v !~ /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/) next
  core_v = v; pre_v = ""; npre_v = 0
  dash = index(v, "-")
  if (dash > 0) { core_v = substr(v, 1, dash - 1); pre_v = substr(v, dash + 1); npre_v = split(pre_v, tmp, ".") }
  if (npre_v > 0 && (tolower(tmp[1]) == "dev" || tolower(tmp[1]) == "alpha")) next
  m++
  core[m] = core_v; pre[m] = pre_v; npre[m] = npre_v; ver[m] = v
}
END {
  for (i = 1; i <= m; i++) {
    for (j = i + 1; j <= m; j++) {
      if (cmp(core[j], pre[j], npre[j], core[i], pre[i], npre[i]) > 0) {
        t_core = core[i]; core[i] = core[j]; core[j] = t_core
        t_pre = pre[i]; pre[i] = pre[j]; pre[j] = t_pre
        t_n = npre[i]; npre[i] = npre[j]; npre[j] = t_n
        t_ver = ver[i]; ver[i] = ver[j]; ver[j] = t_ver
      }
    }
  }
  for (i = 1; i <= m; i++) print ver[i]
}
AWK
)

# Probe a release asset at the download base (through the GitHub proxy rewrite when set):
# 200 means the mirror actually has the version, 404 means it is not synced there yet, and
# anything else (or a transport error) is a hard failure rather than a silent skip.
release_available() {
  ra_url=$(github_url "$1")
  if [ "$downloader" = curl ]; then
    ra_code=$(curl --location --silent --output /dev/null --connect-timeout 20 --max-time 120 --write-out '%{http_code}' "$ra_url") \
      || fail "failed to probe $ra_url (network error)"
    case $ra_code in
      200) return 0 ;;
      404) return 1 ;;
      *) fail "unexpected HTTP $ra_code from $ra_url" ;;
    esac
  else
    if wget -q -O /dev/null "$ra_url"; then
      return 0
    else
      ra_rc=$?
      [ "$ra_rc" -eq 8 ] || fail "failed to probe $ra_url (wget exit $ra_rc)"
      return 1
    fi
  fi
}

# Resolve the newest indexed release whose assets are actually downloadable from $base_url:
# the release index may be fresher than a mirror (e.g. CNB syncs daily), so a version that
# is listed but not yet mirrored must be skipped, never installed-and-failed halfway.
resolve_latest_version() {
  rl_url=$releases_json_url
  echo "Resolving latest dsh version from $rl_url" >&2
  if [ "$downloader" = curl ]; then
    rl_json=$(curl --fail --location --silent --show-error --connect-timeout 20 --max-time 120 "$rl_url") || fail "failed to read the dsh releases JSON from $rl_url"
  else
    rl_json=$(wget -q -O - "$rl_url") || fail "failed to read the dsh releases JSON from $rl_url"
  fi
  rl_candidates=$(printf '%s' "$rl_json" | { grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' || true; } | sed -E 's/^"version"[[:space:]]*:[[:space:]]*"([^"]+)".*$/\1/' | awk "$resolve_latest_awk")
  [ -n "$rl_candidates" ] || fail "no installable dsh release found in $rl_url (dev/alpha prereleases excluded)"
  rl_best=
  for rl_version in $rl_candidates; do
    rl_probe=$base_url/v$rl_version/dsh-v$rl_version-linux-x64.tar.gz.sha256
    echo "Probing $rl_probe" >&2
    if release_available "$rl_probe"; then
      rl_best=$rl_version
      break
    fi
  done
  [ -n "$rl_best" ] || fail "no release listed in $rl_url is available for download at $base_url; the download source may lag behind the index"
  echo "Resolved dsh version: $rl_best (newest available at $base_url)" >&2
  printf '%s' "$rl_best"
}

version=${DSH_VERSION:-}
archive=
checksum=
prefix=${DSH_PREFIX:-"$HOME/.local"}
base_url=${DSH_BASE_URL:-https://github.com/RainEchoA/dsh-cli-standalone/releases/download}
releases_json_url=${DSH_RELEASES_JSON_URL:-https://rainechoa.github.io/dsh-cli-standalone/releases.json}
github_proxy=${DSH_GH_PROXY:-}
modify_path=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --version|--archive|--checksum|--prefix|--base-url|--releases-json-url|--github-proxy)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --version) version=$2 ;;
        --archive) archive=$2 ;;
        --checksum) checksum=$2 ;;
        --prefix) prefix=$2 ;;
        --base-url) base_url=$2 ;;
        --releases-json-url) releases_json_url=$2 ;;
        --github-proxy) github_proxy=$2 ;;
      esac
      shift 2
      ;;
    --no-modify-path) modify_path=0; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ "$(uname -s)" = Linux ] || fail "this installer supports Linux only"
[ "$(uname -m)" = x86_64 ] || fail "unsupported architecture $(uname -m); only x86_64 is supported"
need uname
need awk
need tar
need getconf
need basename
need grep
need sed

libc_version=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail "GNU libc was not detected; musl/Alpine is not supported"
libc_version=${libc_version#glibc }
awk -v current="$libc_version" 'BEGIN {
  split(current, a, "."); split("2.28", b, ".");
  if ((a[1] + 0) < (b[1] + 0) || ((a[1] + 0) == (b[1] + 0) && (a[2] + 0) < (b[2] + 0))) exit 1
}' || fail "glibc >= 2.28 is required; detected $libc_version"

if command -v sha256sum >/dev/null 2>&1; then
  hash_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hash_tool=shasum
else
  fail "required tool not found: sha256sum or shasum"
fi

case "$prefix" in
  *"'"*|*'
'*) fail "prefix cannot contain a single quote or newline" ;;
esac

if command -v curl >/dev/null 2>&1; then
  downloader=curl
elif command -v wget >/dev/null 2>&1; then
  downloader=wget
else
  fail "required downloader not found: curl or wget"
fi

# Version resolution, in priority order: explicit --version, archive file name, latest release.
if [ -n "$archive" ]; then
  archive_name=$(basename -- "$archive")
  case "$archive_name" in
    dsh-v*-win-x64.zip)
      inferred_platform=win
      inferred=${archive_name#dsh-v}
      inferred=${inferred%-win-x64.zip}
      ;;
    dsh-v*-linux-x64.tar.gz)
      inferred_platform=linux
      inferred=${archive_name#dsh-v}
      inferred=${inferred%-linux-x64.tar.gz}
      ;;
    *)
      inferred_platform=
      inferred=
      ;;
  esac
  if [ -z "$version" ]; then
    [ -n "$inferred" ] || fail "cannot determine the dsh version from archive name '$archive_name'; rename it to dsh-v<version>-linux-x64.tar.gz or pass --version explicitly"
    version=$inferred
    echo "Resolved dsh version: $version (from archive name '$archive_name')"
  fi
  if [ -n "$inferred_platform" ] && [ "$inferred_platform" != "linux" ]; then
    fail "archive '$archive_name' is a $inferred_platform-x64 build; this installer only supports linux-x64 archives"
  fi
fi
if [ -z "$version" ]; then
  version=$(resolve_latest_version)
fi
case "$version" in
  *[!0-9A-Za-z._-]*|'') fail "unsafe version string: $version" ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/dsh-install.XXXXXX") || fail "mktemp failed"
new_version_dir=
moved=0
committed=0
cleanup() {
  rc=$?
  if [ "$committed" -eq 0 ] && [ "$moved" -eq 1 ] && [ -n "$new_version_dir" ]; then
    rm -rf "$new_version_dir"
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

name=dsh-v${version}-linux-x64.tar.gz
if [ -n "$archive" ]; then
  [ -f "$archive" ] || fail "local archive not found: $archive"
  archive_dir=$(CDPATH= cd -- "$(dirname -- "$archive")" && pwd)
  archive=$archive_dir/$(basename -- "$archive")
  if [ -z "$checksum" ] && [ -f "$archive.sha256" ]; then
    checksum=$(awk -v file="$(basename -- "$archive")" '{ value=$2; sub(/^\*/, "", value); if (value == file) { print $1; exit } }' "$archive.sha256")
  fi
  if [ -z "$checksum" ]; then
    echo "no .sha256 checksum next to $archive; skipping checksum verification"
  fi
else
  url=$base_url/v$version
  echo "Resolved dsh version: $version"
  echo "Download base URL: $url"
  if [ -n "${https_proxy:-}${HTTPS_PROXY:-}${http_proxy:-}${HTTP_PROXY:-}" ]; then
    echo "Proxy environment: set (credentials suppressed)"
  else
    echo "Proxy environment: not set"
  fi
  if [ "$downloader" = curl ]; then
    curl --fail --location --silent --show-error --connect-timeout 20 --max-time 600 --output "$work/$name" "$(github_url "$url/$name")" || fail "archive download failed: $url/$name"
    curl --fail --location --silent --show-error --connect-timeout 20 --max-time 120 --output "$work/$name.sha256" "$(github_url "$url/$name.sha256")" || fail "checksum download failed: $url/$name.sha256"
  else
    wget -q -O "$work/$name" "$(github_url "$url/$name")" || fail "archive download failed: $url/$name"
    wget -q -O "$work/$name.sha256" "$(github_url "$url/$name.sha256")" || fail "checksum download failed: $url/$name.sha256"
  fi
  archive=$work/$name
  checksum=$(awk -v file="$name" '{ value=$2; sub(/^\*/, "", value); if (value == file) { print $1; exit } }' "$archive.sha256")
fi

if [ -n "$checksum" ]; then
  case "$checksum" in
    *[!0-9a-f]*|'') fail "missing or malformed SHA-256 checksum" ;;
  esac
  [ "${#checksum}" -eq 64 ] || fail "SHA-256 checksum must contain exactly 64 hexadecimal characters"
  if [ "$hash_tool" = sha256sum ]; then
    actual=$(sha256sum "$archive" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  fi
  [ "$actual" = "$checksum" ] || fail "archive checksum mismatch: expected $checksum, got $actual; installation has not changed"
  echo "Verified archive SHA-256: $actual"
fi

tar -tzf "$archive" > "$work/archive-list" || fail "invalid or truncated tar.gz archive"
while IFS= read -r entry; do
  case "$entry" in
    /*|..|../*|*/../*|*/..) fail "unsafe archive entry: $entry" ;;
  esac
done < "$work/archive-list"
mkdir "$work/unpacked"
tar -xzf "$archive" -C "$work/unpacked" || fail "archive extraction failed"
root=$work/unpacked/dsh-v${version}-linux-x64
[ -x "$root/bin/dsh" ] || fail "archive does not contain the expected executable bin/dsh"
[ -f "$root/runtime/node" ] || fail "archive does not contain runtime/node"
[ -f "$root/manifest.json" ] || fail "archive does not contain manifest.json"

reported=$("$root/bin/dsh" --version 2>&1) || fail "staged dsh --version failed: $reported"
[ "$reported" = "$version" ] || fail "staged dsh --version returned $reported; expected $version"
"$root/bin/dsh" web --help >/dev/null || fail "staged dsh web --help failed"

mkdir -p "$prefix/share/dsh/versions" "$prefix/bin"
prefix=$(CDPATH= cd -- "$prefix" && pwd)
new_version_dir=$prefix/share/dsh/versions/$version
[ ! -e "$new_version_dir" ] || fail "version $version is already installed at $new_version_dir; refusing to overwrite it"
mv "$root" "$new_version_dir"
moved=1
"$new_version_dir/bin/dsh" --version >/dev/null || fail "installed dsh --version failed"

shim=$prefix/bin/dsh
if [ -e "$shim" ]; then cp "$shim" "$work/previous-shim"; fi
cat > "$work/new-shim" <<EOF
#!/bin/sh
set -eu
PREFIX=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
exec "\$PREFIX/share/dsh/versions/$version/bin/dsh" "\$@"
EOF
chmod 755 "$work/new-shim"

path_marker='# dsh-cli-standalone user PATH'
case ":$PATH:" in
  *":$prefix/bin:"*) path_ready=1 ;;
  *) path_ready=0 ;;
esac
if [ "$modify_path" -eq 1 ] && [ "$path_ready" -eq 0 ]; then
  profile=$HOME/.profile
  touch "$profile" || fail "cannot write $profile"
  if ! grep -F "export PATH='$prefix/bin'" "$profile" >/dev/null 2>&1; then
    printf "\n%s\nexport PATH='%s/bin':\"\$PATH\"\n" "$path_marker" "$prefix" >> "$profile" || fail "cannot update $profile"
  fi
  echo "Updated $profile; open a new shell or source it to use 'dsh'"
elif [ "$modify_path" -eq 1 ]; then
  echo "$prefix/bin is already on your PATH"
else
  echo "PATH was not modified; add $prefix/bin to your PATH to use 'dsh' from any shell"
fi

mv "$work/new-shim" "$shim" || fail "failed to activate $shim"
if ! activated=$("$shim" --version 2>&1); then
  if [ -f "$work/previous-shim" ]; then cp "$work/previous-shim" "$shim"; else rm -f "$shim"; fi
  fail "activated shim failed: $activated"
fi
if [ "$activated" != "$version" ]; then
  if [ -f "$work/previous-shim" ]; then cp "$work/previous-shim" "$shim"; else rm -f "$shim"; fi
  fail "activated shim returned $activated; expected $version"
fi
committed=1
echo "Installed dsh $version"
echo "Launcher: $shim"
echo "Runtime: $new_version_dir/runtime/node"

# Hint: older versions remain on disk after an upgrade. Show which ones are still
# installed and give the user a copy-paste command to remove them. The active version
# is always excluded, and only safe directory names are considered so the printed
# command can never target an unexpected path.
versions_root=$prefix/share/dsh/versions
old_versions=
for old_dir in "$versions_root"/*; do
  [ -d "$old_dir" ] || continue
  old_name=$(basename -- "$old_dir")
  if [ "$old_name" = "$version" ]; then continue; fi
  case "$old_name" in
    *[!0-9A-Za-z._-]*|'') continue ;;
  esac
  if [ -z "$old_versions" ]; then
    old_versions=$old_name
  else
    old_versions="$old_versions $old_name"
  fi
done
if [ -n "$old_versions" ]; then
  echo
  echo "提示：本机还保留着以下旧版本 dsh：$old_versions"
  echo "当前生效版本为 $version。如需清理旧版本，可执行："
  rm_cmd="rm -rf --"
  for old_name in $old_versions; do
    rm_cmd="$rm_cmd '$versions_root/$old_name'"
  done
  echo "  $rm_cmd"
fi
