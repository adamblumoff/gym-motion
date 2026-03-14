use anyhow::Result;
use tokio::io::{self, AsyncWriteExt};

use crate::protocol::Event;

pub async fn run() -> Result<()> {
    let mut stdout = io::stdout();

    let ready = serde_json::to_string(&Event::Ready {
        platform: std::env::consts::OS.to_string(),
        protocol_version: 1,
    })?;
    stdout.write_all(ready.as_bytes()).await?;
    stdout.write_all(b"\n").await?;

    let error = serde_json::to_string(&Event::Error {
        message: "The Windows BLE sidecar only runs on Windows.".to_string(),
        details: None,
    })?;
    stdout.write_all(error.as_bytes()).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;

    Ok(())
}
