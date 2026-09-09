use crate::modules::logger;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const RELEASE_REPOSITORY: &str = "Huo-zai-feng-lang-li/Antigravity-Manager";
const GITHUB_API_URL: &str =
    "https://api.github.com/repos/Huo-zai-feng-lang-li/Antigravity-Manager/releases/latest";
const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/Huo-zai-feng-lang-li/Antigravity-Manager/releases";
const GITHUB_TAGS_URL: &str =
    "https://api.github.com/repos/Huo-zai-feng-lang-li/Antigravity-Manager/tags";
const GITHUB_RAW_URL: &str =
    "https://raw.githubusercontent.com/Huo-zai-feng-lang-li/Antigravity-Manager/main/package.json";
const JSDELIVR_URL: &str =
    "https://cdn.jsdelivr.net/gh/Huo-zai-feng-lang-li/Antigravity-Manager@main/package.json";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_CHECK_INTERVAL_HOURS: u64 = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: String, // previously release_url
    pub release_notes: String,
    pub published_at: String,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub last_check_time: u64,
    #[serde(default = "default_check_interval")]
    pub check_interval_hours: u64,
}

fn default_check_interval() -> u64 {
    DEFAULT_CHECK_INTERVAL_HOURS
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            last_check_time: 0,
            check_interval_hours: DEFAULT_CHECK_INTERVAL_HOURS,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: String,
    published_at: String,
    #[serde(default)]
    draft: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubTag {
    name: String,
}

const UPDATER_JSON_URL: &str =
    "https://github.com/Huo-zai-feng-lang-li/Antigravity-Manager/releases/latest/download/updater.json";
const GHPROXY_PREFIX: &str = "https://ghproxy.net/";

/// Check for updates with multi-tier fallback strategy and candidate aggregation:
/// 1. Check updater.json (supports direct & ghproxy fallback)
/// 2. Check GitHub Releases (latest & list)
/// 3. Check GitHub Tags (handles new tags without finalized releases)
/// 4. Fallback to GitHub Raw package.json (supports direct & ghproxy fallback)
/// 5. Fallback to jsDelivr package.json
///
/// Aggregates all candidates and resolves the highest available version.
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let mut candidates: Vec<UpdateInfo> = Vec::new();

    // 1. Try updater.json
    match check_updater_json().await {
        Ok(info) => candidates.push(info),
        Err(e) => {
            logger::log_warn(&format!("updater.json check failed: {}", e));
        }
    }

    // 2. Try GitHub Releases
    match check_github_releases().await {
        Ok(Some(info)) => candidates.push(info),
        Ok(None) => {}
        Err(e) => {
            logger::log_warn(&format!("GitHub Releases check failed: {}", e));
        }
    }

    // 3. Try GitHub Tags
    match check_github_tags().await {
        Ok(Some(info)) => candidates.push(info),
        Ok(None) => {}
        Err(e) => {
            logger::log_warn(&format!("GitHub Tags check failed: {}", e));
        }
    }

    // 4. Try GitHub Raw
    match check_static_url(GITHUB_RAW_URL, "GitHub Raw").await {
        Ok(info) => candidates.push(info),
        Err(e) => {
            logger::log_warn(&format!("GitHub Raw check failed: {}", e));
        }
    }

    // 5. Try jsDelivr
    match check_static_url(JSDELIVR_URL, "jsDelivr").await {
        Ok(info) => candidates.push(info),
        Err(e) => {
            logger::log_warn(&format!("jsDelivr check failed: {}", e));
        }
    }

    let current_version = CURRENT_VERSION.to_string();
    let best = resolve_best_candidate(candidates, &current_version)?;

    logger::log_info(&format!(
        "Update check complete: latest={}, current={}, has_update={}, source={:?}",
        best.latest_version, best.current_version, best.has_update, best.source
    ));

    Ok(best)
}

/// Resolve the highest available version among all source candidates.
///
/// Pure function (no network) so the aggregation, source-priority and
/// `has_update` recomputation can be unit tested in isolation.
fn resolve_best_candidate(
    mut candidates: Vec<UpdateInfo>,
    current_version: &str,
) -> Result<UpdateInfo, String> {
    if candidates.is_empty() {
        return Err("All update sources failed to resolve a valid version".to_string());
    }

    let mut best: UpdateInfo = candidates.remove(0);

    for cand in candidates {
        if compare_versions(&cand.latest_version, &best.latest_version) {
            best = cand;
        } else if cand.latest_version == best.latest_version {
            // When versions match, prefer updater.json or GitHub API with richer release notes/links
            let is_cand_rich = cand.source.as_deref() == Some("updater.json")
                || cand.source.as_deref() == Some("GitHub API");
            let is_best_rich = best.source.as_deref() == Some("updater.json")
                || best.source.as_deref() == Some("GitHub API");
            if is_cand_rich && !is_best_rich {
                best = cand;
            }
        }
    }

    best.current_version = current_version.to_string();
    best.has_update = compare_versions(&best.latest_version, current_version);

    Ok(best)
}

#[derive(Debug, Deserialize)]
struct UpdaterJson {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
}

async fn check_updater_json() -> Result<UpdateInfo, String> {
    let client = create_client().await?;
    logger::log_info("Checking for updates via updater.json...");

    let resp = match client.get(UPDATER_JSON_URL).send().await {
        Ok(r) if r.status().is_success() => Ok(r),
        _ => {
            let mirror_url = format!("{}{}", GHPROXY_PREFIX, UPDATER_JSON_URL);
            logger::log_info(&format!("Direct updater.json failed, retrying via mirror: {}", mirror_url));
            client.get(&mirror_url).send().await
        }
    }
    .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "updater.json returned status: {}",
            resp.status()
        ));
    }

    let updater_info: UpdaterJson = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse updater.json: {}", e))?;

    let latest_version = updater_info.version.trim_start_matches('v').to_string();
    let current_version = CURRENT_VERSION.to_string();
    let has_update = compare_versions(&latest_version, &current_version);

    if has_update {
        logger::log_info(&format!(
            "New version found (updater.json): {} (Current: {})",
            latest_version, current_version
        ));
    } else {
        logger::log_info(&format!(
            "Up to date (updater.json): {} (Matches {})",
            current_version, latest_version
        ));
    }

    let download_url = format!(
        "https://github.com/{}/releases/tag/v{}",
        RELEASE_REPOSITORY, latest_version
    );

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url,
        release_notes: updater_info
            .notes
            .unwrap_or_else(|| "Release notes available on GitHub.".to_string()),
        published_at: updater_info
            .pub_date
            .unwrap_or_else(|| Utc::now().to_rfc3339()),
        source: Some("updater.json".to_string()),
    })
}

fn detect_proxy() -> Option<String> {
    // 1. Check user configured upstream proxy first
    if let Ok(config) = crate::modules::config::load_app_config() {
        if config.proxy.upstream_proxy.enabled && !config.proxy.upstream_proxy.url.is_empty() {
            return Some(config.proxy.upstream_proxy.url);
        }
    }

    // 2. Check standard proxy environment variables
    for var in &[
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(val) = std::env::var(var) {
            let val = val.trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }

    // 3. Ultra-fast check of common local proxy ports (15ms timeout)
    let common_ports = [51081, 7890, 7897, 10809, 10808, 20171, 1082];
    for port in common_ports {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(15)).is_ok() {
            return Some(format!("http://127.0.0.1:{}", port));
        }
    }

    None
}

async fn create_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("Antigravity-Manager")
        .timeout(std::time::Duration::from_secs(4));

    if let Some(proxy_url) = detect_proxy() {
        logger::log_info(&format!("Update checker using proxy: {}", proxy_url));
        match reqwest::Proxy::all(&proxy_url) {
            Ok(proxy) => {
                builder = builder.proxy(proxy);
            }
            Err(_) => {
                logger::log_warn("Failed to parse detected proxy");
            }
        }
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

async fn check_github_releases() -> Result<Option<UpdateInfo>, String> {
    let client = create_client().await?;

    logger::log_info("Checking for updates via GitHub Releases API...");

    // First try /releases/latest
    let response = client
        .get(GITHUB_API_URL)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if response.status().is_success() {
        if let Ok(release) = response.json::<GitHubRelease>().await {
            let latest_version = release.tag_name.trim_start_matches('v').to_string();
            let current_version = CURRENT_VERSION.to_string();
            let has_update = compare_versions(&latest_version, &current_version);

            if has_update {
                logger::log_info(&format!(
                    "New version found (GitHub API latest): {} (Current: {})",
                    latest_version, current_version
                ));
            }
            return Ok(Some(UpdateInfo {
                current_version,
                latest_version,
                has_update,
                download_url: release.html_url,
                release_notes: release.body,
                published_at: release.published_at,
                source: Some("GitHub API".to_string()),
            }));
        }
    }

    // Fallback to releases list in case latest tag is not set or prerelease
    let response_list = client
        .get(GITHUB_RELEASES_URL)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response_list.status().is_success() {
        return Err(format!(
            "GitHub Releases returned status: {}",
            response_list.status()
        ));
    }

    let releases: Vec<GitHubRelease> = response_list
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info list: {}", e))?;

    let mut best_release: Option<GitHubRelease> = None;
    let mut best_version = CURRENT_VERSION.to_string();

    for r in releases {
        if r.draft {
            continue;
        }
        let v = r.tag_name.trim_start_matches('v').to_string();
        if compare_versions(&v, &best_version) {
            best_version = v;
            best_release = Some(r);
        }
    }

    if let Some(release) = best_release {
        let current_version = CURRENT_VERSION.to_string();
        let has_update = compare_versions(&best_version, &current_version);
        if has_update {
            logger::log_info(&format!(
                "New version found (GitHub Releases list): {} (Current: {})",
                best_version, current_version
            ));
        }
        return Ok(Some(UpdateInfo {
            current_version,
            latest_version: best_version,
            has_update,
            download_url: release.html_url,
            release_notes: release.body,
            published_at: release.published_at,
            source: Some("GitHub Releases".to_string()),
        }));
    }

    Ok(None)
}

async fn check_github_tags() -> Result<Option<UpdateInfo>, String> {
    let client = create_client().await?;

    logger::log_info("Checking for updates via GitHub Tags API...");

    let response = client
        .get(GITHUB_TAGS_URL)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub Tags returned status: {}",
            response.status()
        ));
    }

    let tags: Vec<GitHubTag> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse tags info: {}", e))?;

    let current_version = CURRENT_VERSION.to_string();
    let mut remaining = tags;

    // Candidates are verified one by one, highest first. A tag whose name does
    // not match the package.json version pinned at that commit is treated as a
    // stale/mis-tagged ref and skipped, so an accidentally high tag on an old
    // commit can never produce a false "update available".
    while let Some(index) = highest_tag_index(&remaining, &current_version) {
        let GitHubTag { name: tag_name } = remaining.remove(index);
        let tag_version = tag_name.trim_start_matches('v').to_string();

        match fetch_package_version_at_ref(&client, &tag_name).await {
            Some(pkg_version) if pkg_version == tag_version => {
                logger::log_info(&format!(
                    "New version found (GitHub Tags): {} (Current: {})",
                    tag_version, current_version
                ));
                return Ok(Some(UpdateInfo {
                    current_version,
                    latest_version: tag_version.clone(),
                    has_update: true,
                    download_url: format!(
                        "https://github.com/{}/releases/tag/{}",
                        RELEASE_REPOSITORY, tag_name
                    ),
                    release_notes: format!(
                        "New version v{} detected on GitHub tags. Please check release page for details.",
                        tag_version
                    ),
                    published_at: Utc::now().to_rfc3339(),
                    source: Some("GitHub Tags".to_string()),
                }));
            }
            Some(pkg_version) => {
                logger::log_warn(&format!(
                    "Skip tag {}: package.json at that ref reports version {}",
                    tag_name, pkg_version
                ));
            }
            None => {
                logger::log_warn(&format!(
                    "Skip tag {}: unable to verify package.json version at that ref",
                    tag_name
                ));
            }
        }
    }

    Ok(None)
}

/// Index of the highest tag newer than `current_version`, or `None`.
///
/// Pure function for unit testing; the caller removes the returned index and
/// may call again to consider lower candidates.
fn highest_tag_index(tags: &[GitHubTag], current_version: &str) -> Option<usize> {
    let mut best_index: Option<usize> = None;
    let mut best_version = current_version.to_string();

    for (index, t) in tags.iter().enumerate() {
        let v = t.name.trim_start_matches('v').to_string();
        if compare_versions(&v, &best_version) {
            best_version = v;
            best_index = Some(index);
        }
    }

    best_index
}

/// Fetch the package.json version pinned at a tag (raw GitHub first, jsDelivr
/// mirror as fallback). Returns `None` when the version cannot be verified.
async fn fetch_package_version_at_ref(
    client: &reqwest::Client,
    tag_name: &str,
) -> Option<String> {
    let urls = [
        format!(
            "https://raw.githubusercontent.com/{}/{}/package.json",
            RELEASE_REPOSITORY, tag_name
        ),
        format!(
            "https://cdn.jsdelivr.net/gh/{}@{}/package.json",
            RELEASE_REPOSITORY, tag_name
        ),
    ];

    for url in urls {
        let response = match client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };

        if let Ok(package) = response.json::<PackageJson>().await {
            return Some(package.version.trim_start_matches('v').to_string());
        }
    }

    None
}

#[derive(Deserialize)]
struct PackageJson {
    version: String,
}

async fn check_static_url(url: &str, source_name: &str) -> Result<UpdateInfo, String> {
    let client = create_client().await?;

    logger::log_info(&format!("Checking for updates via {}...", source_name));

    let resp = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => Ok(r),
        _ => {
            if url.contains("github.com") || url.contains("raw.githubusercontent.com") {
                let mirror_url = format!("{}{}", GHPROXY_PREFIX, url);
                logger::log_info(&format!(
                    "Direct {} failed, retrying via mirror: {}",
                    source_name, mirror_url
                ));
                client.get(&mirror_url).send().await
            } else {
                client.get(url).send().await
            }
        }
    }
    .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "{} returned status: {}",
            source_name,
            resp.status()
        ));
    }

    let package_json: PackageJson = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse package.json: {}", e))?;

    let latest_version = package_json.version.trim_start_matches('v').to_string();
    let current_version = CURRENT_VERSION.to_string();
    let has_update = compare_versions(&latest_version, &current_version);

    if has_update {
        logger::log_info(&format!(
            "New version found ({}): {} (Current: {})",
            source_name, latest_version, current_version
        ));
    } else {
        logger::log_info(&format!(
            "Up to date ({}): {} (Matches {})",
            source_name, current_version, latest_version
        ));
    }

    let download_url = format!("https://github.com/{}/releases/latest", RELEASE_REPOSITORY);
    let release_notes = format!(
        "New version detected via {}. Please check release page for details.",
        source_name
    );

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url,
        release_notes,
        published_at: Utc::now().to_rfc3339(),
        source: Some(source_name.to_string()),
    })
}

fn parse_version_numbers(v: &str) -> Vec<u32> {
    let clean = v.trim_start_matches(|c: char| !c.is_ascii_digit());
    clean
        .split('.')
        .map(|segment| {
            let num_str: String = segment.chars().take_while(|c| c.is_ascii_digit()).collect();
            num_str.parse::<u32>().unwrap_or(0)
        })
        .collect()
}

/// Compare two semantic versions (e.g., "4.7.0" vs "4.6.11", "v4.7.0" vs "4.6.11")
pub fn compare_versions(latest: &str, current: &str) -> bool {
    let latest_parts = parse_version_numbers(latest);
    let current_parts = parse_version_numbers(current);

    let max_len = latest_parts.len().max(current_parts.len());
    for i in 0..max_len {
        let latest_part = latest_parts.get(i).copied().unwrap_or(0);
        let current_part = current_parts.get(i).copied().unwrap_or(0);

        if latest_part > current_part {
            return true;
        } else if latest_part < current_part {
            return false;
        }
    }

    false
}

/// Check if enough time has passed since last check
pub fn should_check_for_updates(settings: &UpdateSettings) -> bool {
    if !settings.auto_check {
        return false;
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let elapsed_hours = now.saturating_sub(settings.last_check_time) / 3600;
    let interval = if settings.check_interval_hours > 0 {
        settings.check_interval_hours
    } else {
        DEFAULT_CHECK_INTERVAL_HOURS
    };
    elapsed_hours >= interval
}

/// Load update settings from config file
pub fn load_update_settings() -> Result<UpdateSettings, String> {
    let data_dir = crate::modules::account::get_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let settings_path = data_dir.join("update_settings.json");

    if !settings_path.exists() {
        return Ok(UpdateSettings::default());
    }

    let content = std::fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings file: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))
}

/// Save update settings to config file
pub fn save_update_settings(settings: &UpdateSettings) -> Result<(), String> {
    let data_dir = crate::modules::account::get_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;
    let settings_path = data_dir.join("update_settings.json");

    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    std::fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write settings file: {}", e))
}

/// Update last check time
pub fn update_last_check_time() -> Result<(), String> {
    let mut settings = load_update_settings()?;
    settings.last_check_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    save_update_settings(&settings)
}

/// Detect if the app was installed via Homebrew Cask (macOS only)
pub fn is_homebrew_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        let caskroom_paths = [
            "/opt/homebrew/Caskroom/antigravity-tools",
            "/usr/local/Caskroom/antigravity-tools",
        ];

        for path in &caskroom_paths {
            if std::path::Path::new(path).exists() {
                logger::log_info(&format!("Detected Homebrew Cask installation at: {}", path));
                return true;
            }
        }
    }

    false
}

/// Detect if the app is currently running as an AppImage (Linux only).
///
/// The AppImage runtime always sets the `APPIMAGE` environment variable to the
/// absolute path of the source `.AppImage` file before mounting and executing the
/// bundled application. This is the canonical way to detect an AppImage execution
/// context without inspecting the filesystem.
///
/// This is used to gate Tauri's native auto-updater on Linux: Tauri's updater plugin
/// only supports AppImage bundles on Linux. Attempting to use it on RPM/DEB-installed
/// binaries results in an `ENOEXEC` error because the downloaded artifact is an
/// AppImage that cannot be executed without FUSE support (or proper permissions).
pub fn is_appimage_running() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var("APPIMAGE").is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Execute `brew upgrade --cask antigravity-tools` with timeout (macOS only)
#[cfg(not(target_os = "macos"))]
pub async fn brew_upgrade_cask() -> Result<String, String> {
    Err("brew_not_supported".to_string())
}

#[cfg(target_os = "macos")]
pub async fn brew_upgrade_cask() -> Result<String, String> {
    logger::log_info("Starting Homebrew Cask upgrade for antigravity-tools...");

    // Find brew binary
    let brew_path = if std::path::Path::new("/opt/homebrew/bin/brew").exists() {
        "/opt/homebrew/bin/brew"
    } else if std::path::Path::new("/usr/local/bin/brew").exists() {
        "/usr/local/bin/brew"
    } else {
        return Err("brew_not_found".to_string());
    };

    // 3 min timeout to prevent hanging
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        tokio::process::Command::new(brew_path)
            .args(["upgrade", "--cask", "antigravity-tools"])
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            logger::log_error(&format!("Failed to execute brew upgrade: {}", e));
            return Err("brew_exec_failed".to_string());
        }
        Err(_) => {
            logger::log_error("Homebrew upgrade timed out after 3 minutes");
            return Err("brew_timeout".to_string());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        logger::log_info(&format!("Homebrew upgrade succeeded: {}", stdout));
        Ok(stdout)
    } else {
        logger::log_error(&format!(
            "brew upgrade failed - stdout: {} stderr: {}",
            stdout, stderr
        ));
        // Return structured error key for frontend i18n
        if stderr.contains("already installed") || stdout.contains("already installed") {
            Err("brew_already_latest".to_string())
        } else {
            Err("brew_upgrade_failed".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compare_versions() {
        assert!(compare_versions("3.3.36", "3.3.35"));
        assert!(compare_versions("3.4.0", "3.3.35"));
        assert!(compare_versions("4.0.3", "3.3.35"));
        assert!(compare_versions("v4.7.0", "4.6.11"));
        assert!(compare_versions("4.7.0", "v4.6.11"));
        assert!(compare_versions("v4.7.0-beta.1", "4.6.11"));
        assert!(!compare_versions("3.3.34", "3.3.35"));
        assert!(!compare_versions("3.3.35", "3.3.35"));
        assert!(!compare_versions("v4.6.11", "4.6.11"));
        assert!(!compare_versions("4.6.10", "4.6.11"));
    }

    #[test]
    fn test_update_sources_follow_release_repository() {
        let urls = [
            GITHUB_API_URL,
            GITHUB_RAW_URL,
            JSDELIVR_URL,
            UPDATER_JSON_URL,
        ];

        for url in urls {
            assert!(
                url.contains("Huo-zai-feng-lang-li/Antigravity-Manager"),
                "update source points to the wrong repository: {url}"
            );
        }
    }

    #[test]
    fn test_should_check_for_updates() {
        let mut settings = UpdateSettings::default();
        assert!(should_check_for_updates(&settings));

        settings.last_check_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(!should_check_for_updates(&settings));

        settings.auto_check = false;
        assert!(!should_check_for_updates(&settings));
    }

    #[test]
    fn test_should_check_for_updates_handles_future_timestamp() {
        let settings = UpdateSettings {
            last_check_time: u64::MAX,
            ..UpdateSettings::default()
        };

        assert!(!should_check_for_updates(&settings));
    }

    fn make_candidate(version: &str, source: &str) -> UpdateInfo {
        UpdateInfo {
            current_version: String::new(),
            latest_version: version.to_string(),
            has_update: false,
            download_url: String::new(),
            release_notes: String::new(),
            published_at: String::new(),
            source: Some(source.to_string()),
        }
    }

    #[test]
    fn test_resolve_best_candidate_empty_returns_error() {
        let result = resolve_best_candidate(Vec::new(), "4.6.10");
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_best_candidate_picks_highest_version() {
        // updater.json lags behind GitHub Tags; the highest version must win
        // regardless of source order.
        let candidates = vec![
            make_candidate("4.6.11", "updater.json"),
            make_candidate("4.7.0", "GitHub Tags"),
            make_candidate("4.6.9", "jsDelivr"),
        ];

        let best = resolve_best_candidate(candidates, "4.6.10").expect("candidates present");
        assert_eq!(best.latest_version, "4.7.0");
        assert_eq!(best.source.as_deref(), Some("GitHub Tags"));
        assert!(best.has_update);
        assert_eq!(best.current_version, "4.6.10");
    }

    #[test]
    fn test_resolve_best_candidate_no_update_when_all_older() {
        let candidates = vec![
            make_candidate("4.6.9", "GitHub Tags"),
            make_candidate("4.6.8", "jsDelivr"),
        ];

        let best = resolve_best_candidate(candidates, "4.6.10").expect("candidates present");
        assert_eq!(best.latest_version, "4.6.9");
        assert!(!best.has_update, "older candidates must not report an update");
    }

    #[test]
    fn test_resolve_best_candidate_same_version_prefers_rich_source() {
        let candidates = vec![
            make_candidate("4.6.11", "jsDelivr"),
            make_candidate("4.6.11", "updater.json"),
        ];

        let best = resolve_best_candidate(candidates, "4.6.10").expect("candidates present");
        assert_eq!(best.latest_version, "4.6.11");
        assert_eq!(
            best.source.as_deref(),
            Some("updater.json"),
            "richer source must win on version tie"
        );
    }

    #[test]
    fn test_highest_tag_index_finds_newer_tag() {
        // Simulates a tag pushed without a finalized GitHub Release:
        // the Tags fallback must still surface the new version.
        let tags = vec![
            GitHubTag { name: "v4.6.9".to_string() },
            GitHubTag { name: "v4.6.11".to_string() },
            GitHubTag { name: "v4.6.10".to_string() },
        ];

        let index = highest_tag_index(&tags, "4.6.10").expect("newer tag exists");
        assert_eq!(tags[index].name, "v4.6.11");
    }

    #[test]
    fn test_highest_tag_index_none_when_all_below_current() {
        let tags = vec![
            GitHubTag { name: "v4.6.8".to_string() },
            GitHubTag { name: "v4.6.9".to_string() },
        ];

        assert!(highest_tag_index(&tags, "4.6.10").is_none());
    }

    #[test]
    fn test_highest_tag_index_skips_rejected_candidate_on_retry() {
        // After the caller removes a mis-tagged high candidate (e.g. v4.7.0
        // pointing at a 4.6.9 commit), the next call must surface the next
        // highest valid tag.
        let tags = vec![
            GitHubTag { name: "v4.7.0".to_string() },
            GitHubTag { name: "v4.6.11".to_string() },
            GitHubTag { name: "v4.6.10".to_string() },
        ];

        let first = highest_tag_index(&tags, "4.6.10").expect("candidate exists");
        assert_eq!(tags[first].name, "v4.7.0");

        let mut remaining = tags;
        remaining.remove(first);
        let second = highest_tag_index(&remaining, "4.6.10").expect("second candidate exists");
        assert_eq!(remaining[second].name, "v4.6.11");
    }
}
