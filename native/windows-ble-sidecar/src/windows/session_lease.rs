use std::time::Duration;

use super::handshake::ControlWriteLock;
use btleplug::platform::Peripheral;
use tokio::sync::{mpsc, watch};

use super::{
    handshake::send_app_session_lease_locked, session_transport::APP_SESSION_HEARTBEAT_MS,
    session_util::format_error_chain,
};

pub(super) fn is_closed_handle_error_message(message: &str) -> bool {
    message.contains("The object has been closed.")
}

pub(super) fn spawn_lease_task(
    control_write_lock: ControlWriteLock,
    peripheral: Peripheral,
    characteristic: btleplug::api::Characteristic,
    session_id: String,
) -> (
    watch::Sender<bool>,
    mpsc::UnboundedReceiver<()>,
    mpsc::UnboundedReceiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let (lease_shutdown_tx, mut lease_shutdown_rx) = watch::channel(false);
    let (lease_success_tx, lease_success_rx) = mpsc::unbounded_channel::<()>();
    let (lease_failure_tx, lease_failure_rx) = mpsc::unbounded_channel::<String>();
    let lease_task = tokio::spawn(async move {
        let mut lease_heartbeat =
            tokio::time::interval(Duration::from_millis(APP_SESSION_HEARTBEAT_MS));
        lease_heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        lease_heartbeat.tick().await;

        loop {
            tokio::select! {
                changed = lease_shutdown_rx.changed() => {
                    if changed.is_ok() && *lease_shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = lease_heartbeat.tick() => {
                    if let Err(error) = send_app_session_lease_locked(
                        &control_write_lock,
                        &peripheral,
                        &characteristic,
                        &session_id,
                    ).await {
                        let _ = lease_failure_tx.send(format_error_chain(&error));
                        break;
                    }
                    let _ = lease_success_tx.send(());
                }
            }
        }
    });

    (
        lease_shutdown_tx,
        lease_success_rx,
        lease_failure_rx,
        lease_task,
    )
}
