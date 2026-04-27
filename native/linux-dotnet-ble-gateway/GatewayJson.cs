using System.Text;
using System.Text.Json;

namespace GymMotion.LinuxBleGateway;

internal static class GatewayJson
{
    public static JsonElement? ParseElement(byte[] bytes)
    {
        var text = Encoding.UTF8.GetString(bytes).Trim('\0', ' ', '\r', '\n', '\t');
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var firstBrace = text.IndexOf('{');
        var lastBrace = text.LastIndexOf('}');
        if (firstBrace >= 0 && lastBrace >= firstBrace)
        {
            text = text[firstBrace..(lastBrace + 1)];
        }

        if (!text.StartsWith("{", StringComparison.Ordinal))
        {
            return null;
        }

        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    public static string? GetString(JsonElement payload, string propertyName)
        => payload.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    public static long? GetInt64(JsonElement payload, string propertyName)
        => payload.TryGetProperty(propertyName, out var property) && property.TryGetInt64(out var value)
            ? value
            : null;

    public static bool? GetBool(JsonElement payload, string propertyName)
        => payload.TryGetProperty(propertyName, out var property) && property.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? property.GetBoolean()
            : null;
}
