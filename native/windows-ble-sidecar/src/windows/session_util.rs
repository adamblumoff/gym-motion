use anyhow::Result;
use btleplug::api::CentralState;

use crate::protocol::Event;

use super::writer::EventWriter;

pub(super) async fn emit_verbose_log(
    writer: &EventWriter,
    enabled: bool,
    message: impl Into<String>,
    details: Option<serde_json::Value>,
) -> Result<()> {
    if !enabled {
        return Ok(());
    }

    writer
        .send(&Event::Log {
            level: "info".to_string(),
            message: message.into(),
            details,
        })
        .await
}

pub(super) fn is_retryable_pre_session_setup_error(error: &anyhow::Error) -> bool {
    let message = format_error_chain(error);
    message.contains("status subscribe step failed")
        || message.contains("subscribe step failed")
        || (message.contains("app-session-bootstrap step failed")
            && message.contains("object has been closed"))
        || (message.contains("app-session-lease step failed")
            && message.contains("object has been closed"))
}

pub(super) fn format_error_chain(error: &anyhow::Error) -> String {
    let mut chain = error.chain();
    let mut formatted = Vec::new();
    while let Some(cause) = chain.next() {
        formatted.push(cause.to_string());
    }
    formatted.join(": ")
}

pub(super) fn normalize_adapter_state(state: CentralState) -> String {
    match state {
        CentralState::PoweredOn => "poweredOn",
        CentralState::PoweredOff => "poweredOff",
        CentralState::Unknown => "unknown",
    }
    .to_string()
}
