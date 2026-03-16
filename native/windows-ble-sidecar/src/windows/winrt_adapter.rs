use std::future::IntoFuture;

use anyhow::Result;

use crate::protocol::AdapterSummary;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WinrtAdapterDescriptor {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) is_available: bool,
    pub(crate) issue: Option<String>,
    pub(crate) details: Vec<String>,
}

impl WinrtAdapterDescriptor {
    pub(crate) fn to_summary(&self) -> AdapterSummary {
        AdapterSummary {
            id: self.id.clone(),
            label: self.label.clone(),
            transport: "winrt".to_string(),
            is_available: self.is_available,
            issue: self.issue.clone(),
            details: self.details.clone(),
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) async fn list_winrt_adapters() -> Result<Vec<WinrtAdapterDescriptor>> {
    use windows::Devices::Radios::{Radio, RadioKind, RadioState};

    let radios = Radio::GetRadiosAsync()?.into_future().await?;
    let mut descriptors = Vec::new();

    for (index, radio) in radios.into_iter().enumerate() {
        if radio.Kind()? != RadioKind::Bluetooth {
            continue;
        }

        let state = radio.State()?;
        let label = radio.Name()?.to_string();
        descriptors.push(WinrtAdapterDescriptor {
            id: format!("winrt:{index}"),
            label: if label.is_empty() {
                "Bluetooth adapter".to_string()
            } else {
                label
            },
            is_available: state == RadioState::On,
            issue: match state {
                RadioState::Disabled => Some("Adapter is disabled.".to_string()),
                RadioState::Off => Some("Adapter is powered off.".to_string()),
                _ => None,
            },
            details: vec![format!("state:{state:?}"), format!("radio_index:{index}")],
        });
    }

    Ok(descriptors)
}

#[cfg(not(target_os = "windows"))]
pub(crate) async fn list_winrt_adapters() -> Result<Vec<WinrtAdapterDescriptor>> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::WinrtAdapterDescriptor;

    #[test]
    fn adapter_descriptors_convert_to_wire_summaries() {
        let descriptor = WinrtAdapterDescriptor {
            id: "winrt:0".to_string(),
            label: "Bluetooth adapter".to_string(),
            is_available: true,
            issue: None,
            details: vec!["state:On".to_string()],
        };

        let summary = descriptor.to_summary();

        assert_eq!(summary.id, "winrt:0");
        assert_eq!(summary.transport, "winrt");
        assert!(summary.is_available);
    }
}
