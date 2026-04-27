using System.Net.Http.Json;

namespace GymMotion.LinuxBleGateway;

internal sealed class BackendTelemetryClient : IDisposable
{
    private static readonly TimeSpan PooledConnectionLifetime = TimeSpan.FromMinutes(15);

    private readonly Uri _backendUrl;
    private readonly HttpClient _httpClient;

    public BackendTelemetryClient(Config config)
    {
        _backendUrl = new Uri(config.BackendUrl.TrimEnd('/') + "/");
        _httpClient = new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = PooledConnectionLifetime,
        });
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "gym-motion-linux-gateway-poc");
        _httpClient.DefaultRequestHeaders.Add("X-Gym-Motion-Gateway-Id", config.GatewayId);
    }

    public Task PostHeartbeatAsync(Dictionary<string, object?> payload, CancellationToken cancellationToken)
        => PostAsync("api/heartbeat", payload, cancellationToken);

    public Task PostMotionAsync(Dictionary<string, object?> payload, CancellationToken cancellationToken)
        => PostAsync("api/ingest", payload, cancellationToken);

    private async Task PostAsync(string path, Dictionary<string, object?> payload, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsJsonAsync(
            new Uri(_backendUrl, path),
            payload,
            cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    public void Dispose()
        => _httpClient.Dispose();
}
