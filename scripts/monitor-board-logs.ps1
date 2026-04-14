param(
  [int]$BaudRate = 115200,
  [int]$PollIntervalMs = 250,
  [switch]$EnableDtr = $true
)

$ErrorActionPreference = 'Stop'

$targetVid = 'VID_2886'
$runtimePids = @('PID_8044', 'PID_8045')
$bootloaderPids = @('PID_0044', 'PID_0045')
$allPids = $runtimePids + $bootloaderPids

function Get-BoardPorts {
  $ports = @(Get-CimInstance Win32_SerialPort | Where-Object {
    $pnp = $_.PNPDeviceID
    if ([string]::IsNullOrEmpty($pnp)) {
      return $false
    }

    if ($pnp -notmatch $targetVid) {
      return $false
    }

    foreach ($pidCode in $allPids) {
      if ($pnp -match $pidCode) {
        return $true
      }
    }

    return $false
  })

  return $ports | ForEach-Object {
    $pnp = $_.PNPDeviceID
    $mode = if ($runtimePids | Where-Object { $pnp -match $_ }) {
      'runtime'
    } elseif ($bootloaderPids | Where-Object { $pnp -match $_ }) {
      'bootloader'
    } else {
      'unknown'
    }

    [pscustomobject]@{
      DeviceID = $_.DeviceID
      Name = $_.Name
      PnpDeviceId = $pnp
      Mode = $mode
    }
  }
}

function Select-PreferredPort {
  param([object[]]$Ports)

  if (-not $Ports -or $Ports.Count -eq 0) {
    return $null
  }

  $runtime = $Ports | Where-Object { $_.Mode -eq 'runtime' } | Select-Object -First 1
  if ($runtime) {
    return $runtime
  }

  return $Ports | Select-Object -First 1
}

function Open-BoardPort {
  param(
    [string]$PortName,
    [int]$PortBaudRate,
    [bool]$UseDtr
  )

  $port = [System.IO.Ports.SerialPort]::new(
    $PortName,
    $PortBaudRate,
    [System.IO.Ports.Parity]::None,
    8,
    [System.IO.Ports.StopBits]::One
  )
  $port.ReadTimeout = 250
  $port.DtrEnable = $UseDtr
  $port.RtsEnable = $false
  $port.NewLine = "`n"
  $port.Open()
  return $port
}

Write-Output ("[board-logs] Watching XIAO board ports at {0} baud. DTR={1}" -f $BaudRate, $EnableDtr.IsPresent)
Write-Output "[board-logs] Press Ctrl+C to stop."

$activePort = $null
$activeInfo = $null

try {
  while ($true) {
    $ports = @(Get-BoardPorts)
    $preferred = Select-PreferredPort -Ports $ports

    if (-not $preferred) {
      if ($activePort) {
        Write-Output ("[board-logs] Port {0} disappeared." -f $activeInfo.DeviceID)
        $activePort.Close()
        $activePort.Dispose()
        $activePort = $null
        $activeInfo = $null
      }

      Start-Sleep -Milliseconds $PollIntervalMs
      continue
    }

    $portChanged = (-not $activeInfo) -or ($activeInfo.DeviceID -ne $preferred.DeviceID)
    if ($portChanged) {
      if ($activePort) {
        Write-Output ("[board-logs] Switching from {0} to {1}." -f $activeInfo.DeviceID, $preferred.DeviceID)
        $activePort.Close()
        $activePort.Dispose()
        $activePort = $null
      }

      try {
        $activePort = Open-BoardPort -PortName $preferred.DeviceID -PortBaudRate $BaudRate -UseDtr $EnableDtr.IsPresent
        $activeInfo = $preferred
        Write-Output ("[board-logs] Attached to {0} ({1}) {2}" -f $activeInfo.DeviceID, $activeInfo.Mode, $activeInfo.PnpDeviceId)
      } catch {
        Write-Output ("[board-logs] Failed to open {0}: {1}" -f $preferred.DeviceID, $_.Exception.Message)
        $activePort = $null
        $activeInfo = $null
        Start-Sleep -Milliseconds $PollIntervalMs
        continue
      }
    }

    if (-not $activePort) {
      Start-Sleep -Milliseconds $PollIntervalMs
      continue
    }

    try {
      $chunk = $activePort.ReadExisting()
      if (-not [string]::IsNullOrEmpty($chunk)) {
        Write-Output $chunk
      }
    } catch {
      Write-Output ("[board-logs] Read failed on {0}: {1}" -f $activeInfo.DeviceID, $_.Exception.Message)
      $activePort.Close()
      $activePort.Dispose()
      $activePort = $null
      $activeInfo = $null
    }

    Start-Sleep -Milliseconds $PollIntervalMs
  }
} finally {
  if ($activePort) {
    $activePort.Close()
    $activePort.Dispose()
  }
}
