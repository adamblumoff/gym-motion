using System.Text.Json;
using Linux.Bluetooth;

namespace GymMotion.LinuxBleGateway;

internal sealed record ApprovedNodeRule(
    string Id,
    string Label,
    string? KnownDeviceId,
    string? LocalName,
    string? Address)
{
    public bool Matches(DeviceProperties device)
    {
        var normalizedAddress = BleAddress.Normalize(device.Address);
        var expectedAddress = BleAddress.Normalize(Address);
        var expectedLocalName = string.IsNullOrWhiteSpace(LocalName)
            ? DeriveAdvertisedName(KnownDeviceId)
            : LocalName;

        if (!string.IsNullOrWhiteSpace(expectedAddress) &&
            string.Equals(expectedAddress, normalizedAddress, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(expectedLocalName) || string.IsNullOrWhiteSpace(device.Name))
        {
            return false;
        }

        return string.Equals(expectedLocalName, device.Name, StringComparison.Ordinal) ||
               device.Name.StartsWith(expectedLocalName + "-s", StringComparison.Ordinal);
    }

    public static IReadOnlyList<ApprovedNodeRule> Load(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var nodes = document.RootElement.ValueKind == JsonValueKind.Array
            ? document.RootElement
            : document.RootElement.GetProperty("nodes");

        var rules = new List<ApprovedNodeRule>();
        var index = 0;
        foreach (var node in nodes.EnumerateArray())
        {
            index++;
            var label = GatewayJson.GetString(node, "label") ?? $"Node {index}";
            var knownDeviceId = GatewayJson.GetString(node, "knownDeviceId") ?? GatewayJson.GetString(node, "known_device_id");
            var localName = GatewayJson.GetString(node, "localName") ?? GatewayJson.GetString(node, "local_name");
            var address = GatewayJson.GetString(node, "address");

            if (knownDeviceId is null && localName is null && address is null)
            {
                throw new InvalidOperationException(
                    $"Approved node '{label}' must include at least one of knownDeviceId, localName, or address.");
            }

            rules.Add(new ApprovedNodeRule(
                Id: GatewayJson.GetString(node, "id") ?? $"rule-{index}",
                Label: label,
                KnownDeviceId: knownDeviceId,
                LocalName: localName,
                Address: address));
        }

        return rules;
    }

    private static string? DeriveAdvertisedName(string? knownDeviceId)
    {
        if (string.IsNullOrWhiteSpace(knownDeviceId))
        {
            return null;
        }

        var suffixStart = Math.Max(0, knownDeviceId.Length - 6);
        return "GymMotion-" + knownDeviceId.Substring(suffixStart);
    }
}
