namespace GymMotion.LinuxBleGateway;

internal sealed class Config
{
    private const string DefaultBackendUrl = "https://gym-motion-production.up.railway.app";

    public required string BackendUrl { get; init; }
    public required string GatewayId { get; init; }
    public required string NodesFile { get; init; }
    public string? AdapterName { get; init; }

    public static Config Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);

        for (var index = 0; index < args.Length; index++)
        {
            var current = args[index];
            if (!current.StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException($"Unsupported argument '{current}'.");
            }

            if (index + 1 >= args.Length)
            {
                throw new ArgumentException($"Missing value for '{current}'.");
            }

            values[current[2..]] = args[++index];
        }

        var backendUrl =
            values.GetValueOrDefault("backend-url") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_CLOUD_API_BASE_URL") ??
            Environment.GetEnvironmentVariable("GATEWAY_BACKEND_URL") ??
            DefaultBackendUrl;
        var gatewayId =
            values.GetValueOrDefault("gateway-id") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_GATEWAY_ID") ??
            Environment.GetEnvironmentVariable("GATEWAY_ID");
        var nodesFile =
            values.GetValueOrDefault("nodes-file") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_GATEWAY_NODES_FILE") ??
            Environment.GetEnvironmentVariable("GATEWAY_NODES_FILE");
        var adapterName =
            values.GetValueOrDefault("adapter") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_GATEWAY_ADAPTER") ??
            Environment.GetEnvironmentVariable("GATEWAY_ADAPTER") ??
            "hci0";

        if (string.IsNullOrWhiteSpace(gatewayId) || string.IsNullOrWhiteSpace(nodesFile))
        {
            throw new ArgumentException(
                "Usage: --gateway-id <id> --nodes-file <path> [--backend-url <url>] [--adapter <hci0>]. " +
                "You can also set GYM_MOTION_GATEWAY_ID, GYM_MOTION_GATEWAY_NODES_FILE, " +
                "GYM_MOTION_CLOUD_API_BASE_URL, and GYM_MOTION_GATEWAY_ADAPTER.");
        }

        return new Config
        {
            BackendUrl = backendUrl.TrimEnd('/'),
            GatewayId = gatewayId,
            NodesFile = nodesFile,
            AdapterName = adapterName,
        };
    }
}
