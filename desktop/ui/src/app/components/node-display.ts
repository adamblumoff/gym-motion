import type { CanonicalNodeStatus } from '../selectors/node-status';

export function formatTelemetryLabel(lastTelemetryAt: string | null) {
  if (!lastTelemetryAt) {
    return 'none';
  }

  const parsed = new Date(lastTelemetryAt);
  if (Number.isNaN(parsed.getTime())) {
    return 'invalid';
  }

  return parsed.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatSensorIssue(sensorIssue: string) {
  if (sensorIssue === 'sensor_no_data') {
    return 'IR sample missing';
  }

  if (sensorIssue === 'sensor_unavailable') {
    return 'IR sensor unavailable';
  }

  if (sensorIssue === 'sensor_whoami_read') {
    return 'IR WHO_AM_I read failed';
  }

  if (sensorIssue === 'sensor_whoami_value') {
    return 'IR WHO_AM_I mismatch';
  }

  if (sensorIssue === 'sensor_ctrl2_reset') {
    return 'IR reset write failed';
  }

  if (sensorIssue === 'sensor_algo_reset') {
    return 'IR algorithm reset failed';
  }

  if (sensorIssue === 'sensor_ctrl1_power_down') {
    return 'IR power-down config failed';
  }

  if (sensorIssue === 'sensor_avg_trim') {
    return 'IR average trim config failed';
  }

  if (sensorIssue === 'sensor_ctrl1_bdu') {
    return 'IR BDU config failed';
  }

  if (sensorIssue === 'sensor_ctrl1_odr') {
    return 'IR ODR config failed';
  }

  if (sensorIssue === 'sensor_bus_recovery') {
    return 'IR bus recovery active';
  }

  if (sensorIssue === 'sensor_bus_sda_low') {
    return 'IR SDA line stuck low';
  }

  if (sensorIssue === 'sensor_bus_scl_low') {
    return 'IR SCL line stuck low';
  }

  return sensorIssue.replaceAll('_', ' ');
}

export function statusToneClassName(status: CanonicalNodeStatus) {
  switch (status) {
    case 'sensor_fault':
    case 'reconnecting':
      return 'text-amber-300';
    case 'disconnected':
      return 'text-red-300';
    case 'moving':
      return 'text-blue-400';
    default:
      return 'text-zinc-300';
  }
}

export function statusIconClassName(status: CanonicalNodeStatus) {
  switch (status) {
    case 'sensor_fault':
    case 'reconnecting':
      return 'bg-amber-500/10';
    case 'disconnected':
      return 'bg-red-500/10';
    case 'moving':
      return 'bg-blue-500/10';
    default:
      return 'bg-zinc-800';
  }
}

export function statusIconTextClassName(status: CanonicalNodeStatus) {
  switch (status) {
    case 'sensor_fault':
    case 'reconnecting':
      return 'text-amber-300';
    case 'disconnected':
      return 'text-red-300';
    case 'moving':
      return 'text-blue-400';
    default:
      return 'text-zinc-500';
  }
}
