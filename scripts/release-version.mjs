const packageVersion = (await Bun.file('package.json').json()).version;
const tauriVersion = (await Bun.file('src-tauri/tauri.conf.json').json()).version;
const cargoToml = await Bun.file('src-tauri/Cargo.toml').text();
const packageStart = cargoToml.indexOf('[package]');
const packageEnd = cargoToml.indexOf('\n[', packageStart + 1);
const packageSection = cargoToml.slice(packageStart, packageEnd === -1 ? undefined : packageEnd);
const cargoVersion = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

if (!packageVersion || packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
	throw new Error(
		`Version mismatch: package.json=${packageVersion}, tauri.conf.json=${tauriVersion}, Cargo.toml=${cargoVersion}`
	);
}

process.stdout.write(packageVersion);
