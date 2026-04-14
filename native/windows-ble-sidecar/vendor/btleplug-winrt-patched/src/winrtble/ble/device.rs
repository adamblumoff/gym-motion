// btleplug Source Code File
//
// Copyright 2020 Nonpolynomial Labs LLC. All rights reserved.
//
// Licensed under the BSD 3-Clause license. See LICENSE file in the project root
// for full license information.
//
// Some portions of this file are taken and/or modified from Rumble
// (https://github.com/mwylde/rumble), using a dual MIT/Apache License under the
// following copyright:
//
// Copyright (c) 2014 The Rust Project Developers

use std::time::Duration;

use crate::{Error, Result, api::BDAddr, winrtble::utils};
use log::{debug, trace, warn};
use tokio::time::{sleep, timeout};
use windows::{
    Devices::Bluetooth::{
        BluetoothCacheMode, BluetoothConnectionStatus, BluetoothLEDevice,
        BluetoothLEPreferredConnectionParameters,
        GenericAttributeProfile::{
            GattCharacteristic, GattCommunicationStatus, GattDescriptor, GattDeviceService,
            GattDeviceServicesResult, GattSession,
        },
    },
    Foundation::TypedEventHandler,
    Win32::{
        Devices::Bluetooth::{
            BLUETOOTH_FIND_RADIO_PARAMS, BluetoothFindFirstRadio, BluetoothFindNextRadio,
        },
        Foundation::{CloseHandle, HANDLE},
        System::{
            IO::DeviceIoControl,
            Ioctl::{FILE_ANY_ACCESS, FILE_DEVICE_BLUETOOTH, METHOD_BUFFERED},
        },
    },
};

/// Timeout for uncached GATT operations before falling back to cached mode.
/// Some Windows BLE drivers hang indefinitely on uncached requests (see #325).
const GATT_CACHE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_WAIT_TIMEOUT: Duration = Duration::from_secs(4);
const CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const BTH_IOCTL_BASE: u32 = 0;
const IOCTL_BTH_DISCONNECT_DEVICE: u32 = ctl_code(
    FILE_DEVICE_BLUETOOTH,
    BTH_IOCTL_BASE + 0x03,
    METHOD_BUFFERED,
    FILE_ANY_ACCESS,
);

pub type ConnectedEventHandler = Box<dyn Fn(bool) + Send>;
pub type MaxPduSizeChangedEventHandler = Box<dyn Fn(u16) + Send>;

pub struct BLEDevice {
    address: BDAddr,
    device: BluetoothLEDevice,
    gatt_session: GattSession,
    connection_token: i64,
    pdu_change_token: i64,
    services: Vec<GattDeviceService>,
}

const fn ctl_code(device_type: u32, function: u32, method: u32, access: u32) -> u32 {
    (device_type << 16) | (access << 14) | (function << 2) | method
}

impl BLEDevice {
    pub async fn new(
        address: BDAddr,
        connection_status_changed: ConnectedEventHandler,
        max_pdu_size_changed: MaxPduSizeChangedEventHandler,
    ) -> Result<Self> {
        let async_op = BluetoothLEDevice::FromBluetoothAddressAsync(address.into())
            .map_err(|_| Error::DeviceNotFound)?;
        let device = async_op.await.map_err(|_| Error::DeviceNotFound)?;

        let async_op = GattSession::FromDeviceIdAsync(&device.BluetoothDeviceId()?)
            .map_err(|_| Error::DeviceNotFound)?;
        let gatt_session = async_op.await.map_err(|_| Error::DeviceNotFound)?;

        let connection_status_handler =
            TypedEventHandler::<BluetoothLEDevice, _>::new(move |sender, _| {
                if let Some(sender) = sender.as_ref() {
                    let is_connected = sender
                        .ConnectionStatus()
                        .ok()
                        .map_or(false, |v| v == BluetoothConnectionStatus::Connected);
                    connection_status_changed(is_connected);
                    trace!("state {:?}", sender.ConnectionStatus());
                }
                Ok(())
            });
        let connection_token = device
            .ConnectionStatusChanged(&connection_status_handler)
            .map_err(|_| Error::Other("Could not add connection status handler".into()))?;

        max_pdu_size_changed(gatt_session.MaxPduSize().unwrap());
        let max_pdu_size_changed_handler =
            TypedEventHandler::<GattSession, _>::new(move |sender, _| {
                if let Some(sender) = sender.as_ref() {
                    max_pdu_size_changed(sender.MaxPduSize().unwrap());
                }
                Ok(())
            });
        let pdu_change_token = gatt_session
            .MaxPduSizeChanged(&max_pdu_size_changed_handler)
            .map_err(|_| Error::Other("Could not add max pdu size changed handler".into()))?;

        Ok(BLEDevice {
            address,
            device,
            gatt_session,
            connection_token,
            pdu_change_token,
            services: vec![],
        })
    }

    fn force_disconnect_via_radio(&self) -> Result<bool> {
        let mut radio = HANDLE::default();
        let find_params = BLUETOOTH_FIND_RADIO_PARAMS {
            dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
        };
        let find_handle = unsafe { BluetoothFindFirstRadio(&find_params, &mut radio) }
            .map_err(|error| Error::Other(format!("BluetoothFindFirstRadio failed: {error:?}").into()))?;
        let _find_handle = find_handle;
        let remote_address = u64::from(self.address);
        let mut issued_disconnect = false;
        let mut last_error: Option<Error> = None;

        loop {
            let mut bytes_returned = 0u32;
            match unsafe {
                DeviceIoControl(
                    radio,
                    IOCTL_BTH_DISCONNECT_DEVICE,
                    Some((&remote_address as *const u64).cast()),
                    std::mem::size_of::<u64>() as u32,
                    None,
                    0,
                    Some(&mut bytes_returned),
                    None,
                )
            } {
                Ok(()) => {
                    issued_disconnect = true;
                }
                Err(error) => {
                    last_error = Some(Error::Other(
                        format!("IOCTL_BTH_DISCONNECT_DEVICE failed: {error:?}").into(),
                    ));
                }
            }

            unsafe {
                let _ = CloseHandle(radio);
            }

            let mut next_radio = HANDLE::default();
            if unsafe { BluetoothFindNextRadio(find_handle, &mut next_radio) }.is_err() {
                break;
            }
            radio = next_radio;
        }

        if issued_disconnect {
            return Ok(true);
        }

        if let Some(error) = last_error {
            return Err(error);
        }

        Ok(false)
    }

    async fn get_gatt_services(
        &self,
        cache_mode: BluetoothCacheMode,
    ) -> Result<GattDeviceServicesResult> {
        let winrt_error = |e| Error::Other(format!("{:?}", e).into());
        let async_op = self
            .device
            .GetGattServicesWithCacheModeAsync(cache_mode)
            .map_err(winrt_error)?;
        let service_result = async_op.await.map_err(winrt_error)?;
        Ok(service_result)
    }

    pub fn name(&self) -> windows::core::Result<windows::core::HSTRING> {
        self.device.Name()
    }

    pub async fn connect(&self) -> Result<()> {
        let winrt_error = |e| Error::Other(format!("{:?}", e).into());
        if self.is_connected().await? {
            return Ok(());
        }

        self.gatt_session
            .SetMaintainConnection(true)
            .map_err(winrt_error)?;

        timeout(CONNECT_WAIT_TIMEOUT, async {
            loop {
                if self.is_connected().await? {
                    return Ok::<(), Error>(());
                }

                sleep(CONNECT_POLL_INTERVAL).await;
            }
        })
        .await
        .map_err(|_| Error::NotConnected)??;

        let service_result = self.get_gatt_services(BluetoothCacheMode::Uncached).await?;
        let status = service_result.Status().map_err(|_| Error::DeviceNotFound)?;
        utils::to_error(status)
    }

    pub async fn disconnect(&self) -> Result<()> {
        let winrt_error = |e| Error::Other(format!("{:?}", e).into());
        match self.force_disconnect_via_radio() {
            Ok(true) => {
                trace!("Forced Bluetooth radio disconnect for {}", self.address);
            }
            Ok(false) => {
                trace!(
                    "Bluetooth radio disconnect was not issued for {}; falling back to GattSession teardown",
                    self.address
                );
            }
            Err(error) => {
                warn!(
                    "Bluetooth radio disconnect failed for {}: {:?}",
                    self.address, error
                );
            }
        }
        self.gatt_session
            .SetMaintainConnection(false)
            .map_err(winrt_error)?;
        timeout(CONNECT_WAIT_TIMEOUT, async {
            loop {
                if !self.is_connected().await.unwrap_or(true) {
                    return Ok::<(), Error>(());
                }

                sleep(CONNECT_POLL_INTERVAL).await;
            }
        })
        .await
        .map_err(|_| {
            Error::Other(
                format!(
                    "timed out waiting for WinRT BLE device {} to disconnect after teardown",
                    self.address
                )
                .into(),
            )
        })??;
        Ok(())
    }

    async fn is_connected(&self) -> Result<bool> {
        let winrt_error = |e| Error::Other(format!("{:?}", e).into());
        let status = self.device.ConnectionStatus().map_err(winrt_error)?;

        Ok(status == BluetoothConnectionStatus::Connected)
    }

    pub async fn get_characteristics(
        service: &GattDeviceService,
    ) -> Result<Vec<GattCharacteristic>> {
        let async_result = match timeout(
            GATT_CACHE_TIMEOUT,
            service
                .GetCharacteristicsWithCacheModeAsync(BluetoothCacheMode::Uncached)?
                .into_future(),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                warn!("Uncached characteristic discovery timed out, falling back to cached mode");
                service
                    .GetCharacteristicsWithCacheModeAsync(BluetoothCacheMode::Cached)?
                    .await?
            }
        };

        match async_result.Status() {
            Ok(GattCommunicationStatus::Success) => {
                let results = async_result.Characteristics()?;
                debug!("characteristics {:?}", results.Size());
                Ok(results.into_iter().collect())
            }
            Ok(GattCommunicationStatus::ProtocolError) => Err(Error::Other(
                format!(
                    "get_characteristics for {:?} encountered a protocol error",
                    service
                )
                .into(),
            )),
            Ok(status) => {
                debug!("characteristic read failed due to {:?}", status);
                Ok(vec![])
            }
            Err(e) => Err(Error::Other(
                format!("get_characteristics for {:?} failed: {:?}", service, e).into(),
            )),
        }
    }

    pub async fn get_characteristic_descriptors(
        characteristic: &GattCharacteristic,
    ) -> Result<Vec<GattDescriptor>> {
        let async_result = match timeout(
            GATT_CACHE_TIMEOUT,
            characteristic
                .GetDescriptorsWithCacheModeAsync(BluetoothCacheMode::Uncached)?
                .into_future(),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                warn!("Uncached descriptor discovery timed out, falling back to cached mode");
                characteristic
                    .GetDescriptorsWithCacheModeAsync(BluetoothCacheMode::Cached)?
                    .await?
            }
        };
        let status = async_result.Status();
        if status == Ok(GattCommunicationStatus::Success) {
            let results = async_result.Descriptors()?;
            debug!("descriptors {:?}", results.Size());
            Ok(results.into_iter().collect())
        } else {
            Err(Error::Other(
                format!(
                    "get_characteristic_descriptors for {:?} failed: {:?}",
                    characteristic, status
                )
                .into(),
            ))
        }
    }

    pub fn get_connection_parameters(&self) -> Result<crate::api::ConnectionParameters> {
        let winrt_error = |e| Error::Other(format!("{:?}", e).into());
        let params = self.device.GetConnectionParameters().map_err(winrt_error)?;
        // ConnectionInterval is in units of 1.25ms, convert to microseconds
        let interval_us = (params.ConnectionInterval().map_err(winrt_error)? as u32) * 1250;
        let latency = params.ConnectionLatency().map_err(winrt_error)? as u16;
        // LinkTimeout is in units of 10ms, convert to microseconds
        let supervision_timeout_us = (params.LinkTimeout().map_err(winrt_error)? as u32) * 10_000;
        Ok(crate::api::ConnectionParameters {
            interval_us,
            latency,
            supervision_timeout_us,
        })
    }

    pub fn request_connection_parameters(
        &self,
        preset: crate::api::ConnectionParameterPreset,
    ) -> Result<()> {
        let winrt_error = |e| Error::Other(format!("{:?}", e).into());
        let params = match preset {
            crate::api::ConnectionParameterPreset::Balanced => {
                BluetoothLEPreferredConnectionParameters::Balanced()
            }
            crate::api::ConnectionParameterPreset::ThroughputOptimized => {
                BluetoothLEPreferredConnectionParameters::ThroughputOptimized()
            }
            crate::api::ConnectionParameterPreset::PowerOptimized => {
                BluetoothLEPreferredConnectionParameters::PowerOptimized()
            }
        }
        .map_err(winrt_error)?;
        let result = self
            .device
            .RequestPreferredConnectionParameters(&params)
            .map_err(winrt_error)?;
        let status = result.Status().map_err(winrt_error)?;
        // BluetoothLEPreferredConnectionParametersRequestStatus:
        //   Unspecified = 0, Success = 1, DeviceNotAvailable = 2, AccessDenied = 3
        match status.0 {
            1 => Ok(()),
            2 | 3 => Err(Error::NotSupported(format!(
                "request_connection_parameters not supported (status {:?})",
                status
            ))),
            _ => Err(Error::Other(
                format!(
                    "RequestPreferredConnectionParameters failed with status {:?}",
                    status
                )
                .into(),
            )),
        }
    }

    pub async fn discover_services(&mut self) -> Result<&[GattDeviceService]> {
        let winrt_error = |e| Error::Other(format!("{:?}", e).into());
        let service_result = self.get_gatt_services(BluetoothCacheMode::Uncached).await?;
        let status = service_result.Status().map_err(winrt_error)?;
        if status == GattCommunicationStatus::Success {
            // We need to convert the IVectorView to a Vec, because IVectorView is not Send and so
            // can't be help past the await point below.
            let services: Vec<_> = service_result
                .Services()
                .map_err(winrt_error)?
                .into_iter()
                .collect();
            self.services = services;
            debug!("services {:?}", self.services.len());
        }
        Ok(self.services.as_slice())
    }
}

impl Drop for BLEDevice {
    fn drop(&mut self) {
        let result = self
            .gatt_session
            .RemoveMaxPduSizeChanged(self.pdu_change_token);
        if let Err(err) = result {
            debug!("Drop: remove_max_pdu_size_changed {:?}", err);
        }

        let result = self
            .device
            .RemoveConnectionStatusChanged(self.connection_token);
        if let Err(err) = result {
            debug!("Drop:remove_connection_status_changed {:?}", err);
        }

        self.services.iter().for_each(|service| {
            if let Err(err) = service.Close() {
                debug!("Drop:remove_gatt_Service {:?}", err);
            }
        });
        self.services.clear();

        let result = self.gatt_session.Close();
        if let Err(err) = result {
            debug!("Drop:close_gatt_session {:?}", err);
        }

        let result = self.device.Close();
        if let Err(err) = result {
            debug!("Drop:close {:?}", err);
        }
    }
}
