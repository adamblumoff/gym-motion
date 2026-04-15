using System.IO.Ports;
using System.Text;

namespace GymMotion.WindowsSerialBridgeRelay;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var options = RelayOptions.Parse(args);
        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };

        try
        {
            using var port = new SerialPort(
                options.PortName,
                options.BaudRate,
                Parity.None,
                8,
                StopBits.One);
            port.DtrEnable = options.DtrEnabled;
            port.RtsEnable = false;
            port.NewLine = "\n";
            port.ReadTimeout = 50;
            port.WriteTimeout = 500;
            port.Encoding = Encoding.UTF8;
            port.Open();

            await Console.Error.WriteLineAsync($"[relay] opened {options.PortName} @ {options.BaudRate}");

            var stdinTask = PumpStdinToSerialAsync(port, cancellation.Token);
            var serialTask = PumpSerialToStdoutAsync(port, cancellation.Token);

            await Task.WhenAny(stdinTask, serialTask);
            cancellation.Cancel();

            try
            {
                await Task.WhenAll(stdinTask, serialTask);
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown.
            }

            return 0;
        }
        catch (Exception error)
        {
            await Console.Error.WriteLineAsync($"[relay] error {error.Message}");
            return 1;
        }
    }

    private static async Task PumpStdinToSerialAsync(SerialPort port, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await Console.In.ReadLineAsync(cancellationToken);
            if (line is null)
            {
                return;
            }

            if (line.Length == 0)
            {
                continue;
            }

            port.Write(line);
            port.Write("\n");
        }
    }

    private static async Task PumpSerialToStdoutAsync(SerialPort port, CancellationToken cancellationToken)
    {
        var buffer = new StringBuilder();

        while (!cancellationToken.IsCancellationRequested)
        {
            string? chunk = null;
            try
            {
                chunk = port.ReadExisting();
            }
            catch (TimeoutException)
            {
                chunk = null;
            }
            catch (InvalidOperationException)
            {
                return;
            }

            if (!string.IsNullOrEmpty(chunk))
            {
                buffer.Append(chunk);

                while (true)
                {
                    var newlineIndex = buffer.ToString().IndexOf('\n');
                    if (newlineIndex < 0)
                    {
                        break;
                    }

                    var line = buffer.ToString(0, newlineIndex).Trim();
                    buffer.Remove(0, newlineIndex + 1);

                    if (line.Length == 0)
                    {
                        continue;
                    }

                    await Console.Out.WriteLineAsync(line);
                    await Console.Out.FlushAsync(cancellationToken);
                }
            }

            await Task.Delay(15, cancellationToken);
        }
    }

    private sealed record RelayOptions(string PortName, int BaudRate, bool DtrEnabled)
    {
        public static RelayOptions Parse(string[] args)
        {
            string? portName = null;
            var baudRate = 115_200;
            var dtrEnabled = true;

            for (var index = 0; index < args.Length; index += 1)
            {
                var arg = args[index];
                switch (arg)
                {
                    case "--port":
                        portName = ReadValue(args, ref index, "--port");
                        break;
                    case "--baud":
                        baudRate = int.Parse(ReadValue(args, ref index, "--baud"));
                        break;
                    case "--dtr":
                        dtrEnabled = ReadValue(args, ref index, "--dtr") != "0";
                        break;
                }
            }

            if (string.IsNullOrWhiteSpace(portName))
            {
                throw new InvalidOperationException("Missing required --port argument.");
            }

            return new RelayOptions(portName, baudRate, dtrEnabled);
        }

        private static string ReadValue(string[] args, ref int index, string name)
        {
            if (index + 1 >= args.Length)
            {
                throw new InvalidOperationException($"Missing value for {name}.");
            }

            index += 1;
            return args[index];
        }
    }
}
