//! Host detection for MORROW.
//!
//! Every probe reports either what it actually detected or that detection is
//! unavailable, with a reason. Nothing here guesses or fills in plausible values.
//! The serialised shape matches `SystemReportSchema` in `@morrow/schemas`.

use serde::Serialize;
use sysinfo::{Disks, Networks, System};

/// Result of probing one aspect of the host.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status")]
pub enum Probe<T> {
    #[serde(rename = "DETECTED")]
    Detected { value: T },
    #[serde(rename = "UNAVAILABLE")]
    Unavailable { reason: String },
}

impl<T> Probe<T> {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Probe::Unavailable { reason: reason.into() }
    }
    pub fn is_detected(&self) -> bool {
        matches!(self, Probe::Detected { .. })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub family: String,
    pub name: Option<String>,
    pub version: Option<String>,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub brand: String,
    pub physical_cores: Option<u32>,
    pub logical_cores: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub adapters: Vec<GpuAdapter>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GpuAdapter {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount_point: String,
    pub kind: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StorageInfo {
    pub disks: Vec<DiskInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub interface_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SystemReport {
    pub os: Probe<OsInfo>,
    pub cpu: Probe<CpuInfo>,
    pub memory: Probe<MemoryInfo>,
    pub gpu: Probe<GpuInfo>,
    pub storage: Probe<StorageInfo>,
    pub network: Probe<NetworkInfo>,
}

/// Probe the host. Blocking; takes on the order of tens of milliseconds.
pub fn probe() -> SystemReport {
    let mut sys = System::new_all();
    sys.refresh_all();

    SystemReport {
        os: probe_os(),
        cpu: probe_cpu(&sys),
        memory: probe_memory(&sys),
        // No portable GPU enumeration is wired in yet; say so rather than guess.
        gpu: Probe::unavailable("GPU detection is not implemented yet"),
        storage: probe_storage(),
        network: probe_network(),
    }
}

fn probe_os() -> Probe<OsInfo> {
    Probe::Detected {
        value: OsInfo {
            family: std::env::consts::OS.to_string(),
            name: System::name(),
            version: System::os_version(),
            arch: std::env::consts::ARCH.to_string(),
        },
    }
}

fn probe_cpu(sys: &System) -> Probe<CpuInfo> {
    let cpus = sys.cpus();
    let Some(first) = cpus.first() else {
        return Probe::unavailable("The operating system reported no CPUs");
    };
    Probe::Detected {
        value: CpuInfo {
            brand: first.brand().trim().to_string(),
            physical_cores: System::physical_core_count().map(|n| n as u32),
            logical_cores: cpus.len() as u32,
        },
    }
}

fn probe_memory(sys: &System) -> Probe<MemoryInfo> {
    let total = sys.total_memory();
    if total == 0 {
        return Probe::unavailable("The operating system reported no memory information");
    }
    Probe::Detected {
        value: MemoryInfo {
            total_bytes: total,
            available_bytes: sys.available_memory(),
        },
    }
}

fn probe_storage() -> Probe<StorageInfo> {
    let disks = Disks::new_with_refreshed_list();
    let list: Vec<DiskInfo> = disks
        .list()
        .iter()
        .map(|d| DiskInfo {
            mount_point: d.mount_point().to_string_lossy().into_owned(),
            kind: format!("{:?}", d.kind()),
            total_bytes: d.total_space(),
            available_bytes: d.available_space(),
        })
        .collect();
    if list.is_empty() {
        return Probe::unavailable("No disks were reported");
    }
    Probe::Detected {
        value: StorageInfo { disks: list },
    }
}

fn probe_network() -> Probe<NetworkInfo> {
    let networks = Networks::new_with_refreshed_list();
    Probe::Detected {
        value: NetworkInfo {
            interface_count: networks.list().len() as u32,
        },
    }
}

/// Subset of `InitCheckSchema` that the native layer reports (ENVIRONMENT, COMPUTER).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InitCheck {
    pub subsystem: &'static str,
    pub status: &'static str,
    pub summary: String,
    pub details: Vec<String>,
}

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// The ENVIRONMENT check, built from a probe report.
pub fn environment_check(report: &SystemReport) -> InitCheck {
    let mut details = Vec::new();
    let mut parts = Vec::new();
    match &report.os {
        Probe::Detected { value } => {
            let name = value.name.clone().unwrap_or_else(|| value.family.clone());
            let version = value.version.clone().unwrap_or_default();
            parts.push(format!("{name} {version}").trim().to_string());
            details.push(format!("OS: {name} {version} ({})", value.arch).trim().to_string());
        }
        Probe::Unavailable { reason } => details.push(format!("OS: unavailable — {reason}")),
    }
    match &report.cpu {
        Probe::Detected { value } => {
            parts.push(format!("{} threads", value.logical_cores));
            details.push(format!("CPU: {} · {} logical cores", value.brand, value.logical_cores));
        }
        Probe::Unavailable { reason } => details.push(format!("CPU: unavailable — {reason}")),
    }
    match &report.memory {
        Probe::Detected { value } => {
            let total = value.total_bytes as f64 / GIB;
            parts.push(format!("{total:.0} GB"));
            details.push(format!(
                "Memory: {:.1} GB total, {:.1} GB available",
                total,
                value.available_bytes as f64 / GIB
            ));
        }
        Probe::Unavailable { reason } => details.push(format!("Memory: unavailable — {reason}")),
    }
    match &report.gpu {
        Probe::Detected { value } => {
            for a in &value.adapters {
                details.push(format!("GPU: {}", a.name));
            }
        }
        Probe::Unavailable { reason } => details.push(format!("GPU: unavailable — {reason}")),
    }
    match &report.storage {
        Probe::Detected { value } => {
            for d in &value.disks {
                details.push(format!(
                    "Disk {}: {:.0} GB free of {:.0} GB",
                    d.mount_point,
                    d.available_bytes as f64 / GIB,
                    d.total_bytes as f64 / GIB
                ));
            }
        }
        Probe::Unavailable { reason } => details.push(format!("Storage: unavailable — {reason}")),
    }
    match &report.network {
        Probe::Detected { value } => details.push(format!("Network: {} interface(s)", value.interface_count)),
        Probe::Unavailable { reason } => details.push(format!("Network: unavailable — {reason}")),
    }

    let core_detected = report.os.is_detected() && report.cpu.is_detected() && report.memory.is_detected();
    InitCheck {
        subsystem: "ENVIRONMENT",
        status: if core_detected { "READY" } else { "DEGRADED" },
        summary: parts.join(" · "),
        details,
    }
}

/// The COMPUTER check. Computer vision/control is part of the architecture but not built yet.
pub fn computer_check() -> InitCheck {
    InitCheck {
        subsystem: "COMPUTER",
        status: "UNAVAILABLE",
        summary: "Computer control not implemented".to_string(),
        details: vec![
            "Screen capture and input control are planned native capabilities".to_string(),
            "They will run only through the permission engine (screen.capture, input.control)".to_string(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_detects_core_facts_on_this_host() {
        let report = probe();
        assert!(report.os.is_detected());
        assert!(report.cpu.is_detected());
        assert!(report.memory.is_detected());
        // GPU must be reported as unavailable until a real detector exists.
        assert!(matches!(report.gpu, Probe::Unavailable { .. }));
    }

    #[test]
    fn serialises_to_the_shared_schema_shape() {
        let report = SystemReport {
            os: Probe::Detected {
                value: OsInfo { family: "windows".into(), name: Some("Windows".into()), version: Some("11".into()), arch: "x86_64".into() },
            },
            cpu: Probe::Detected { value: CpuInfo { brand: "cpu".into(), physical_cores: Some(8), logical_cores: 16 } },
            memory: Probe::Detected { value: MemoryInfo { total_bytes: 10, available_bytes: 5 } },
            gpu: Probe::unavailable("not implemented"),
            storage: Probe::Detected { value: StorageInfo { disks: vec![] } },
            network: Probe::Detected { value: NetworkInfo { interface_count: 2 } },
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["os"]["status"], "DETECTED");
        assert_eq!(json["cpu"]["value"]["logicalCores"], 16);
        assert_eq!(json["memory"]["value"]["totalBytes"], 10);
        assert_eq!(json["gpu"]["status"], "UNAVAILABLE");
        assert_eq!(json["gpu"]["reason"], "not implemented");
        assert_eq!(json["network"]["value"]["interfaceCount"], 2);
    }

    #[test]
    fn environment_check_is_degraded_without_core_facts() {
        let report = SystemReport {
            os: Probe::unavailable("x"),
            cpu: Probe::unavailable("x"),
            memory: Probe::unavailable("x"),
            gpu: Probe::unavailable("x"),
            storage: Probe::unavailable("x"),
            network: Probe::unavailable("x"),
        };
        let check = environment_check(&report);
        assert_eq!(check.status, "DEGRADED");
        assert!(check.details.iter().all(|d| d.contains("unavailable")));
    }
}
