#pragma once

#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <string>

namespace firmware_runtime {
namespace json {
namespace detail {

inline std::size_t skipWhitespace(const std::string& json, std::size_t position) {
  while (position < json.size() &&
         std::isspace(static_cast<unsigned char>(json[position]))) {
    position += 1;
  }

  return position;
}

inline bool skipString(const std::string& json, std::size_t& position) {
  if (position >= json.size() || json[position] != '"') {
    return false;
  }

  position += 1;
  while (position < json.size()) {
    if (json[position] == '\\') {
      position += 2;
      continue;
    }

    if (json[position] == '"') {
      position += 1;
      return true;
    }

    position += 1;
  }

  return false;
}

inline bool skipValue(const std::string& json, std::size_t& position, std::uint8_t depth);

inline bool skipComposite(
  const std::string& json,
  std::size_t& position,
  char open,
  char close,
  std::uint8_t depth
) {
  if (position >= json.size() || json[position] != open) {
    return false;
  }

  position += 1;
  position = skipWhitespace(json, position);
  if (position < json.size() && json[position] == close) {
    position += 1;
    return true;
  }

  while (position < json.size()) {
    if (open == '{') {
      if (!skipString(json, position)) {
        return false;
      }

      position = skipWhitespace(json, position);
      if (position >= json.size() || json[position] != ':') {
        return false;
      }

      position += 1;
    }

    if (!skipValue(json, position, depth)) {
      return false;
    }

    position = skipWhitespace(json, position);
    if (position >= json.size()) {
      return false;
    }

    if (json[position] == close) {
      position += 1;
      return true;
    }

    if (json[position] != ',') {
      return false;
    }

    position += 1;
    position = skipWhitespace(json, position);
  }

  return false;
}

inline bool skipValue(const std::string& json, std::size_t& position, std::uint8_t depth) {
  if (depth == 0) {
    return false;
  }

  position = skipWhitespace(json, position);
  if (position >= json.size()) {
    return false;
  }

  const char current = json[position];
  if (current == '"') {
    return skipString(json, position);
  }

  if (current == '{') {
    return skipComposite(json, position, '{', '}', static_cast<std::uint8_t>(depth - 1));
  }

  if (current == '[') {
    return skipComposite(json, position, '[', ']', static_cast<std::uint8_t>(depth - 1));
  }

  if (current == '-' || std::isdigit(static_cast<unsigned char>(current))) {
    position += 1;
    while (position < json.size()) {
      const char value = json[position];
      if (std::isdigit(static_cast<unsigned char>(value)) ||
          value == '.' || value == 'e' || value == 'E' ||
          value == '+' || value == '-') {
        position += 1;
        continue;
      }

      break;
    }

    return true;
  }

  if (json.compare(position, 4, "true") == 0 || json.compare(position, 4, "null") == 0) {
    position += 4;
    return true;
  }

  if (json.compare(position, 5, "false") == 0) {
    position += 5;
    return true;
  }

  return false;
}

inline bool decodeStringToken(
  const std::string& json,
  std::size_t start,
  std::size_t end,
  std::string& output
) {
  if (end <= start + 1 || json[start] != '"' || json[end - 1] != '"') {
    return false;
  }

  output.clear();
  output.reserve(end - start - 2);

  for (std::size_t index = start + 1; index + 1 < end; ++index) {
    const char current = json[index];
    if (current != '\\') {
      output.push_back(current);
      continue;
    }

    index += 1;
    if (index >= end - 1) {
      return false;
    }

    switch (json[index]) {
      case '"':
      case '\\':
      case '/':
        output.push_back(json[index]);
        break;
      case 'b':
        output.push_back('\b');
        break;
      case 'f':
        output.push_back('\f');
        break;
      case 'n':
        output.push_back('\n');
        break;
      case 'r':
        output.push_back('\r');
        break;
      case 't':
        output.push_back('\t');
        break;
      default:
        return false;
    }
  }

  return true;
}

inline bool parseUnsignedLongToken(
  const std::string& json,
  std::size_t start,
  std::size_t end,
  unsigned long& value
) {
  if (start >= end) {
    return false;
  }

  for (std::size_t index = start; index < end; ++index) {
    if (!std::isdigit(static_cast<unsigned char>(json[index]))) {
      return false;
    }
  }

  value = static_cast<unsigned long>(
    std::strtoull(json.substr(start, end - start).c_str(), nullptr, 10)
  );
  return true;
}

}  // namespace detail

class ObjectReader {
 public:
  explicit ObjectReader(const std::string& json) : json_(json) {}

  bool isObject() const {
    std::size_t position = detail::skipWhitespace(json_, 0);
    if (position >= json_.size() || json_[position] != '{') {
      return false;
    }

    if (!detail::skipComposite(json_, position, '{', '}', 8)) {
      return false;
    }

    position = detail::skipWhitespace(json_, position);
    return position == json_.size();
  }

  bool hasKey(const char* key) const {
    std::size_t start = 0;
    std::size_t end = 0;
    return findValue(key, start, end);
  }

  bool readString(const char* key, std::string& value) const {
    std::size_t start = 0;
    std::size_t end = 0;
    return findValue(key, start, end) && detail::decodeStringToken(json_, start, end, value);
  }

  unsigned long readUnsignedLong(const char* key, unsigned long fallback) const {
    std::size_t start = 0;
    std::size_t end = 0;
    unsigned long value = fallback;
    if (!findValue(key, start, end) || !detail::parseUnsignedLongToken(json_, start, end, value)) {
      return fallback;
    }

    return value;
  }

 private:
  bool findValue(const char* key, std::size_t& valueStart, std::size_t& valueEnd) const {
    std::size_t position = detail::skipWhitespace(json_, 0);
    if (position >= json_.size() || json_[position] != '{') {
      return false;
    }

    position += 1;
    position = detail::skipWhitespace(json_, position);
    if (position < json_.size() && json_[position] == '}') {
      return false;
    }

    while (position < json_.size()) {
      const std::size_t keyStart = position;
      if (!detail::skipString(json_, position)) {
        return false;
      }

      std::string parsedKey;
      if (!detail::decodeStringToken(json_, keyStart, position, parsedKey)) {
        return false;
      }

      position = detail::skipWhitespace(json_, position);
      if (position >= json_.size() || json_[position] != ':') {
        return false;
      }

      position += 1;
      position = detail::skipWhitespace(json_, position);

      const std::size_t tokenStart = position;
      if (!detail::skipValue(json_, position, 8)) {
        return false;
      }

      if (parsedKey == key) {
        valueStart = tokenStart;
        valueEnd = position;
        return true;
      }

      position = detail::skipWhitespace(json_, position);
      if (position >= json_.size()) {
        return false;
      }

      if (json_[position] == '}') {
        return false;
      }

      if (json_[position] != ',') {
        return false;
      }

      position += 1;
      position = detail::skipWhitespace(json_, position);
    }

    return false;
  }

  const std::string& json_;
};

}  // namespace json
}  // namespace firmware_runtime
