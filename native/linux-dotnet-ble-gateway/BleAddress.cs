namespace GymMotion.LinuxBleGateway;

internal static class BleAddress
{
    public static string? Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        var cleaned = new string(value.Where(char.IsAsciiHexDigit).ToArray()).ToUpperInvariant();
        return cleaned.Length == 12
            ? string.Join(":", Enumerable.Range(0, 6).Select(index => cleaned.Substring(index * 2, 2)))
            : value.ToUpperInvariant();
    }
}
