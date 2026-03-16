use std::sync::Arc;

use anyhow::Result;
use tokio::{
    io::{self, AsyncWriteExt},
    sync::Mutex,
};

use crate::protocol::Event;

#[derive(Clone)]
pub(crate) struct EventWriter {
    inner: Arc<Mutex<io::Stdout>>,
}

impl EventWriter {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(io::stdout())),
        }
    }

    pub(crate) async fn send(&self, event: &Event) -> Result<()> {
        let encoded = serde_json::to_string(event)?;
        let mut stdout = self.inner.lock().await;
        stdout.write_all(encoded.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
        Ok(())
    }

    pub(crate) async fn error(
        &self,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) {
        let _ = self
            .send(&Event::Error {
                message: message.into(),
                details,
            })
            .await;
    }
}
