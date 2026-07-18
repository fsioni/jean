fn main() {
    tauri_build::build();

    // Embed Common Controls v6 into Windows MSVC link lines.
    //
    // `tauri_build` embeds the app manifest for the main binary via winres, but
    // `cargo test --lib` produces a separate unit-test harness that does not get
    // that resource. Without the manifest, linking Tauri window/test APIs makes
    // the harness fail to start with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).
    //
    // Use `cargo:rustc-link-arg` (not `-tests`): this package only has unit tests
    // under `src/`, so Cargo rejects `rustc-link-arg-tests` ("does not have a
    // test target").
    //
    // See: https://github.com/tauri-apps/tauri/pull/4383#issuecomment-1212221864
    //      https://github.com/orgs/tauri-apps/discussions/11179
    embed_windows_manifest_for_msvc();
}

fn embed_windows_manifest_for_msvc() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());

    let Some(manifest) = manifest.to_str() else {
        println!(
            "cargo:warning=Windows app manifest path is not valid UTF-8; skipping test manifest embed"
        );
        return;
    };

    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{manifest}");
}
