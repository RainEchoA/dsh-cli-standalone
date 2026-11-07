#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  ./install.sh --version <dsh-version> [options]

Options:
  --archive <file>       Install a local dsh-v<version>-linux-x64.tar.gz
  --checksum <sha256>    Expected archive checksum; otherwise read <archive>.sha256
  --prefix <directory>   Installation prefix (default: $HOME/.local)
  --base-url <url>       Release download URL without a trailing slash
  --no-modify-path       Do not append $prefix/bin to $HOME/.profile

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

version=
archive=
checksum=
prefix=${DSH_PREFIX:-"$HOME/.local"}
base_url=https://github.com/RainEchoA/dsh-cli-standalone/releases/download
modify_path=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --version|--archive|--checksum|--prefix|--base-url)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      case "$1" in
        --version) version=$2 ;;
        --archive) archive=$2 ;;
        --checksum) checksum=$2 ;;
        --prefix) prefix=$2 ;;
        --base-url) base_url=$2 ;;
      esac
      shift 2
      ;;
    --no-modify-path) modify_path=0; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$version" ] || { usage >&2; fail "--version is required; there is no implicit latest-version fallback"; }
case "$version" in
  *[!0-9A-Za-z._-]*|'') fail "unsafe version string: $version" ;;
esac
[ "$(uname -s)" = Linux ] || fail "this installer supports Linux only"
[ "$(uname -m)" = x86_64 ] || fail "unsupported architecture $(uname -m); only x86_64 is supported"
need uname
need awk
need tar
need getconf

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
  if [ -z "$checksum" ]; then
    [ -f "$archive.sha256" ] || fail "local installation requires --checksum or a sibling $(basename -- "$archive").sha256"
    checksum=$(awk -v file="$(basename -- "$archive")" '{ value=$2; sub(/^\*/, "", value); if (value == file) { print $1; exit } }' "$archive.sha256")
  fi
else
  url=$base_url/v$version
  need basename
  if command -v curl >/dev/null 2>&1; then
    downloader=curl
  elif command -v wget >/dev/null 2>&1; then
    downloader=wget
  else
    fail "required downloader not found: curl or wget"
  fi
  echo "Resolved dsh version: $version"
  echo "Download base URL: $url"
  if [ -n "${https_proxy:-}${HTTPS_PROXY:-}${http_proxy:-}${HTTP_PROXY:-}" ]; then
    echo "Proxy environment: set (credentials suppressed)"
  else
    echo "Proxy environment: not set"
  fi
  if [ "$downloader" = curl ]; then
    curl --fail --location --silent --show-error --connect-timeout 20 --max-time 600 --output "$work/$name" "$url/$name" || fail "archive download failed: $url/$name"
    curl --fail --location --silent --show-error --connect-timeout 20 --max-time 120 --output "$work/$name.sha256" "$url/$name.sha256" || fail "checksum download failed: $url/$name.sha256"
  else
    wget -q -O "$work/$name" "$url/$name" || fail "archive download failed: $url/$name"
    wget -q -O "$work/$name.sha256" "$url/$name.sha256" || fail "checksum download failed: $url/$name.sha256"
  fi
  archive=$work/$name
  checksum=$(awk -v file="$name" '{ value=$2; sub(/^\*/, "", value); if (value == file) { print $1; exit } }' "$archive.sha256")
fi

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
  echo "Updated $profile; open a new shell or source it to refresh PATH"
elif [ "$modify_path" -eq 0 ]; then
  echo "PATH modification disabled; add $prefix/bin to PATH manually"
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
