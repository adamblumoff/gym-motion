use std::time::Duration;

use tokio::sync::{mpsc, watch};

use super::{
    handshake::send_app_session_lease,
    session::ActiveSessionControl,
    session_transport::APP_SESSION_HEARTBEAT_MS,
    session_util::format_error_chain,
};

pub(super) fn is_closed_handle_error_message(message: &str) -> bool {
    message.contains("The object has been closed.")
}

pub(super) fn spawn_lease_task(
    control: ActiveSessionControl,
    session_id: String,
) -> (
    watch::Sender<bool>,
    mpsc::UnboundedReceiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let (lease_shutdown_tx, mut lease_shutdown_rx) = watch::channel(false);
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
                    let write_guard = control.write_lock.lock().await;
                    let result = send_app_session_lease(
                        &control.peripheral,
                        &control.characteristic,
                        &session_id,
                    ).await;
                    drop(write_guard);
                    if let Err(error) = result {
                        let _ = lease_failure_tx.send(format_error_chain(&error));
                        break;
                    }
                }
            }
        }
    });

    (lease_shutdown_tx, lease_failure_rx, lease_task)
}
