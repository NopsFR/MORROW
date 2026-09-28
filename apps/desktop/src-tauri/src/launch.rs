//! Where the agent runtime, its Node.js binary and its data live.
//!
//! Resolution, per item, in order:
//! 1. an explicit override (`MORROW_NODE`, `MORROW_RUNTIME_SCRIPT`, `MORROW_MIGRATIONS_DIR`);
//! 2. the **bundled runtime** shipped as app resources (`<resources>/runtime/...`,
//!    assembled by `scripts/prepare-runtime.mjs`) — packaged installs need nothing else;
//! 3. the repository layout, for development (`node` from PATH, `agent/dist`, `database/migrations`).
//!
//! Data always lives in the OS app-data directory, never a hard-coded path.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use morrow_runtime_bridge::RuntimeLaunch;
use tauri::{AppHandle, Manager};

const NODE_BINARY: &str = if cfg!(windows) { "node.exe" } else { "node" };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSource {
    Bundled,
    Development,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimePaths {
    pub node: PathBuf,
    pub script: PathBuf,
    pub migrations: PathBuf,
    pub source: RuntimeSource,
}

/// Pure resolution logic, separated from Tauri so it can be tested.
pub fn resolve_paths(
    env: impl Fn(&str) -> Option<OsString>,
    resource_dir: Option<&Path>,
    repo_root: &Path,
    exists: impl Fn(&Path) -> bool,
) -> RuntimePaths {
    let bundled = resource_dir
        .map(|dir| dir.join("runtime"))
        .filter(|dir| exists(&dir.join("morrow-runtime.mjs")) && exists(&dir.join(NODE_BINARY)));

    let (default_node, default_script, default_migrations, source) = match &bundled {
        Some(dir) => (
            dir.join(NODE_BINARY),
            dir.join("morrow-runtime.mjs"),
            dir.join("migrations"),
            RuntimeSource::Bundled,
        ),
        None => (
            PathBuf::from("node"),
            repo_root.join("agent").join("dist").join("morrow-runtime.mjs"),
            repo_root.join("database").join("migrations"),
            RuntimeSource::Development,
        ),
    };

    RuntimePaths {
        node: env("MORROW_NODE").map(PathBuf::from).unwrap_or(default_node),
        script: env("MORROW_RUNTIME_SCRIPT").map(PathBuf::from).unwrap_or(default_script),
        migrations: env("MORROW_MIGRATIONS_DIR").map(PathBuf::from).unwrap_or(default_migrations),
        source,
    }
}

/// Removes the Windows extended-length prefix (`\\?\C:\...`, `\\?\UNC\server\...`) that
/// Tauri's path resolver can return. Node.js cannot resolve its entry script from such a
/// path (`EISDIR: lstat 'C:'`), so the bundled runtime would exit at startup. Other paths
/// are returned unchanged.
pub fn plain_path(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else { return path };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        // Only drive-letter paths are safe to shorten; leave e.g. volume GUID paths alone.
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            PathBuf::from(rest)
        } else {
            path
        }
    } else {
        path
    }
}

fn repo_root() -> PathBuf {
    // apps/desktop/src-tauri → repository root (only meaningful in development builds)
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

pub fn resolve(app: &AppHandle) -> Result<RuntimeLaunch, Box<dyn std::error::Error>> {
    let data_dir = plain_path(app.path().app_data_dir()?);
    std::fs::create_dir_all(&data_dir)?;
    let resource_dir = app.path().resource_dir().ok().map(plain_path);

    let paths = resolve_paths(|k| std::env::var_os(k), resource_dir.as_deref(), &repo_root(), |p| p.exists());
    eprintln!("[morrow] agent runtime: {:?} ({})", paths.source, paths.script.display());

    Ok(RuntimeLaunch {
        node: paths.node,
        script: paths.script,
        data_dir,
        migrations_dir: Some(paths.migrations),
        request_timeout: Duration::from_secs(30),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    #[test]
    fn prefers_the_bundled_runtime_when_present() {
        let resources = PathBuf::from("/app/resources");
        let present: HashSet<PathBuf> = [
            resources.join("runtime").join("morrow-runtime.mjs"),
            resources.join("runtime").join(NODE_BINARY),
        ]
        .into();
        let paths = resolve_paths(no_env, Some(&resources), Path::new("/repo"), |p| present.contains(p));
        assert_eq!(paths.source, RuntimeSource::Bundled);
        assert_eq!(paths.node, resources.join("runtime").join(NODE_BINARY));
        assert_eq!(paths.migrations, resources.join("runtime").join("migrations"));
    }

    #[test]
    fn falls_back_to_the_repository_in_development() {
        let paths = resolve_paths(no_env, Some(Path::new("/app/resources")), Path::new("/repo"), |_| false);
        assert_eq!(paths.source, RuntimeSource::Development);
        assert_eq!(paths.node, PathBuf::from("node"));
        assert_eq!(paths.script, Path::new("/repo").join("agent").join("dist").join("morrow-runtime.mjs"));
    }

    #[test]
    fn a_partial_bundle_is_not_used() {
        let resources = PathBuf::from("/app/resources");
        let only_script = resources.join("runtime").join("morrow-runtime.mjs");
        let paths = resolve_paths(no_env, Some(&resources), Path::new("/repo"), |p| p == only_script);
        assert_eq!(paths.source, RuntimeSource::Development);
    }

    #[test]
    fn explicit_overrides_win() {
        let env = |k: &str| (k == "MORROW_NODE").then(|| OsString::from("/custom/node"));
        let paths = resolve_paths(env, None, Path::new("/repo"), |_| false);
        assert_eq!(paths.node, PathBuf::from("/custom/node"));
    }

    #[test]
    fn extended_length_prefixes_are_removed() {
        assert_eq!(
            plain_path(PathBuf::from(r"\\?\C:\Program Files\MORROW")),
            PathBuf::from(r"C:\Program Files\MORROW")
        );
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\server\share\app")), PathBuf::from(r"\\server\share\app"));
        assert_eq!(plain_path(PathBuf::from(r"C:\already\plain")), PathBuf::from(r"C:\already\plain"));
        assert_eq!(plain_path(PathBuf::from("/app/resources")), PathBuf::from("/app/resources"));
        let volume = PathBuf::from(r"\\?\Volume{1234}\dir");
        assert_eq!(plain_path(volume.clone()), volume);
    }
}
