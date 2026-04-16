import type {
  NodeConnectionStatus,
  NodeMotionStatus,
  NodeSensorStatus,
  NodeVisualTone,
} from '../selectors/node-status';

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

export function connectionToneClassName(status: NodeConnectionStatus) {
  switch (status) {
    case 'connected':
      return 'text-zinc-300';
    case 'reconnecting':
      return 'text-amber-300';
    default:
      return 'text-red-300';
  }
}

export function sensorToneClassName(status: NodeSensorStatus) {
  switch (status) {
    case 'healthy':
      return 'text-zinc-300';
    case 'waiting_for_sample':
      return 'text-amber-200';
    default:
      return 'text-amber-300';
  }
}

export function motionToneClassName(status: NodeMotionStatus) {
  return status === 'moving' ? 'text-blue-400' : 'text-zinc-300';
}

export function statusToneClassName(status: NodeVisualTone) {
  switch (status) {
    case 'warning':
      return 'text-amber-300';
    case 'offline':
      return 'text-red-300';
    case 'moving':
      return 'text-blue-400';
    default:
      return 'text-zinc-300';
  }
}

export function statusIconClassName(status: NodeVisualTone) {
  switch (status) {
    case 'warning':
      return 'bg-amber-500/10';
    case 'offline':
      return 'bg-red-500/10';
    case 'moving':
      return 'bg-blue-500/10';
    default:
      return 'bg-zinc-800';
  }
}

export function statusIconTextClassName(status: NodeVisualTone) {
  switch (status) {
    case 'warning':
      return 'text-amber-300';
    case 'offline':
      return 'text-red-300';
    case 'moving':
      return 'text-blue-400';
    default:
      return 'text-zinc-500';
  }
}
