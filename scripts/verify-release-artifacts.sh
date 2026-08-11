#!/bin/bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
	printf 'usage: %s <artifact-dir> <version>\n' "$0" >&2
	exit 2
fi

artifact_dir="$1"
version="$2"
deb="${artifact_dir}/RegMon_${version}_amd64.deb"
exe="${artifact_dir}/RegMon.exe"

expected_entries="$(printf '%s\n' 'RegMon.exe' "RegMon_${version}_amd64.deb" | LC_ALL=C sort)"
actual_entries="$(find "$artifact_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
[[ "$actual_entries" == "$expected_entries" ]]
[[ -z "$(find "$artifact_dir" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]]
[[ -s "$deb" ]]
[[ -s "$exe" ]]

deb_file_type="$(file --brief "$deb")"
grep -Fq 'Debian binary package' <<<"$deb_file_type"
[[ "$(dpkg-deb --field "$deb" Package)" == 'reg-mon' ]]
[[ "$(dpkg-deb --field "$deb" Version)" == "$version" ]]
[[ "$(dpkg-deb --field "$deb" Architecture)" == 'amd64' ]]

depends="$(dpkg-deb --field "$deb" Depends)"
dependency_names="$(
	printf '%s\n' "$depends" \
		| tr ',|' '\n\n' \
		| sed -E 's/[[:space:]]*\([^)]*\)//g; s/:[[:alnum:]-]+//g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
		| grep -E '.+'
)"
for required_dependency in libgtk-3-0 libudev1 libwebkit2gtk-4.1-0; do
	[[ "$(grep -Fxc "$required_dependency" <<<"$dependency_names")" -eq 1 ]]
done
[[ -z "$(LC_ALL=C sort <<<"$dependency_names" | uniq -d)" ]]

exe_file_type="$(file --brief "$exe")"
grep -Fq 'PE32+' <<<"$exe_file_type"
grep -Fq 'x86-64' <<<"$exe_file_type"
grep -Eq '\(GUI\)|Windows GUI' <<<"$exe_file_type"

pe_headers="$(llvm-readobj --file-headers "$exe")"
grep -Eq 'Format:[[:space:]]+COFF-x86-64' <<<"$pe_headers"
grep -Eq 'Arch:[[:space:]]+x86_64' <<<"$pe_headers"
grep -Eq 'AddressSize:[[:space:]]+64bit' <<<"$pe_headers"
grep -Eq 'Magic:[[:space:]]+(0x20B|PE32\+)' <<<"$pe_headers"
grep -Eq 'Subsystem:[[:space:]]+IMAGE_SUBSYSTEM_WINDOWS_GUI[[:space:]]+\(0x2\)' <<<"$pe_headers"

pe_imports="$(llvm-readobj --coff-imports "$exe")"
if grep -Eiq '(^|[^[:alnum:]_])(VCRUNTIME[^[:space:]]*\.dll|MSVCP[^[:space:]]*\.dll|WebView2Loader\.dll)([^[:alnum:]_]|$)' <<<"$pe_imports"; then
	exit 1
fi
[[ -z "$(find "$artifact_dir" -mindepth 1 -maxdepth 1 -type f -iname '*.dll' -print -quit)" ]]
