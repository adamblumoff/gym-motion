// btleplug Source Code File
//
// Copyright 2020 Nonpolynomial. All rights reserved.
//
// Licensed under the BSD 3-Clause license. See LICENSE file in the project root
// for full license information.

use crate::api::ValueNotification;
use futures::stream::{Stream, StreamExt};
use log::warn;
use std::pin::Pin;
use tokio::sync::broadcast::Receiver;
use tokio_stream::wrappers::{errors::BroadcastStreamRecvError, BroadcastStream};

pub fn notifications_stream_from_broadcast_receiver(
    receiver: Receiver<ValueNotification>,
) -> Pin<Box<dyn Stream<Item = ValueNotification> + Send>> {
    Box::pin(BroadcastStream::new(receiver).filter_map(|result| async move {
        match result {
            Ok(notification) => Some(notification),
            Err(BroadcastStreamRecvError::Lagged(skipped)) => {
                warn!(
                    "WinRT BLE notification stream lagged and dropped {} message(s)",
                    skipped
                );
                None
            }
        }
    }))
}
