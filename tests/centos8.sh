#!/bin/sh
set -eu

[ "$#" -eq 2 ] || { echo "Usage: sh tests/centos8.sh <version> <archive-path>" >&2; exit 2; }
version=$1
archive=$2
[ -f "$archive" ] || { echo "Archive not found: $archive" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive_abs=$(CDPATH= cd -- "$(dirname -- "$archive")" && pwd)/$(basename -- "$archive")
archive_rel=${archive_abs#"$root"/}
[ "$archive_rel" != "$archive_abs" ] || { echo "Archive must be under $root so the container can read it" >&2; exit 1; }

docker run --rm -v "$root:/src:ro" quay.io/centos/centos:8 sh -c '
  set -eu
  version=$1
  archive=$2
  echo "Container baseline:"
  cat /etc/centos-release
  getconf GNU_LIBC_VERSION
  if command -v node >/dev/null 2>&1; then
    echo "Unexpected preinstalled Node.js: $(command -v node)" >&2
    exit 1
  fi
  /src/install.sh --version "$version" --archive "/src/$archive" --prefix /tmp/dsh-prefix --no-modify-path
  /tmp/dsh-prefix/bin/dsh --version
  /tmp/dsh-prefix/bin/dsh web --help >/dev/null
  /tmp/dsh-prefix/share/dsh/versions/$version/runtime/node /src/scripts/verify-standalone.mjs \
    --archive "/src/$archive" --version "$version" --platform linux
' sh "$version" "$archive_rel"

echo "CENTOS8_ARCHIVE_VERIFICATION_PASS (glibc 2.28 userland; host kernel not asserted as 4.18)"
