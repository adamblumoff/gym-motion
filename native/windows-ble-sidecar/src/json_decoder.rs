use anyhow::{anyhow, Result};
use serde_json::Value;

const MAX_BUFFER_LENGTH: usize = 64 * 1024;

#[derive(Debug, Default)]
pub struct JsonObjectDecoder {
    label: String,
    buffer: String,
    framed_buffer: Option<String>,
}

impl JsonObjectDecoder {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            buffer: String::new(),
            framed_buffer: None,
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn push_bytes(&mut self, chunk: &[u8]) -> Result<Vec<Value>> {
        let value = std::str::from_utf8(chunk)
            .map_err(|error| anyhow!("{} utf8 decode failed: {error}", self.label))?;

        self.push_str(value)
    }

    pub fn push_str(&mut self, value: &str) -> Result<Vec<Value>> {
        if let Some(rest) = value.strip_prefix("BEGIN:") {
            let _ = rest;
            self.framed_buffer = Some(String::new());
            return Ok(Vec::new());
        }

        if let Some(framed) = self.framed_buffer.as_mut() {
            if value == "END" {
                let candidate = self.framed_buffer.take().unwrap_or_default();
                return Ok(vec![serde_json::from_str(&candidate).map_err(|error| {
                    anyhow!("{} framed json parse failed: {error}", self.label)
                })?]);
            }

            framed.push_str(value);

            if framed.len() > MAX_BUFFER_LENGTH {
                self.framed_buffer = None;
                return Err(anyhow!(
                    "{} framed buffer overflow while waiting for END",
                    self.label
                ));
            }

            return Ok(Vec::new());
        }

        self.buffer.push_str(value);

        let mut objects = Vec::new();

        while self.trim_leading_noise() {
            let Some(object_end) = find_complete_object_end(&self.buffer) else {
                if self.buffer.len() > MAX_BUFFER_LENGTH {
                    self.buffer.clear();
                    return Err(anyhow!(
                        "{} buffer overflow while waiting for JSON end",
                        self.label
                    ));
                }
                return Ok(objects);
            };

            let candidate = self.buffer[..=object_end].to_string();
            self.buffer = self.buffer[object_end + 1..].to_string();
            objects.push(
                serde_json::from_str(&candidate)
                    .map_err(|error| anyhow!("{} json parse failed: {error}", self.label))?,
            );
        }

        Ok(objects)
    }

    fn trim_leading_noise(&mut self) -> bool {
        let Some(object_start) = self.buffer.find('{') else {
            if self.buffer.len() > MAX_BUFFER_LENGTH {
                self.buffer.clear();
            }
            return false;
        };

        if object_start > 0 {
            self.buffer = self.buffer[object_start..].to_string();
        }

        true
    }
}

fn find_complete_object_end(buffer: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in buffer.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        match character {
            '\\' => {
                escaped = true;
            }
            '"' => {
                in_string = !in_string;
            }
            '{' if !in_string => {
                depth += 1;
            }
            '}' if !in_string => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::JsonObjectDecoder;

    #[test]
    fn decodes_split_json_objects() {
        let mut decoder = JsonObjectDecoder::new("telemetry");
        assert!(decoder
            .push_str("{\"state\":\"mov")
            .expect("partial chunk should not fail")
            .is_empty());

        let values = decoder
            .push_str("ing\"}")
            .expect("final chunk should decode");

        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["state"], "moving");
    }

    #[test]
    fn decodes_framed_messages() {
        let mut decoder = JsonObjectDecoder::new("status");
        assert!(decoder
            .push_str("BEGIN:12")
            .expect("begin should parse")
            .is_empty());
        assert!(decoder
            .push_str("{\"ok\":")
            .expect("middle chunk should parse")
            .is_empty());
        let values = decoder
            .push_str("true}")
            .expect("last framed chunk should parse");
        assert!(values.is_empty());

        let framed = decoder.push_str("END").expect("end should decode");
        assert_eq!(framed[0]["ok"], true);
    }
}
