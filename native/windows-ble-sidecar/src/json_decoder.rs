use anyhow::{anyhow, Result};
use serde_json::json;
use serde_json::Value;

const MAX_BUFFER_LENGTH: usize = 64 * 1024;
const ERROR_SNIPPET_LENGTH: usize = 512;

#[derive(Debug, Default)]
pub struct JsonObjectDecoder {
    label: String,
    buffer: String,
    framed_buffer: Option<FramedBuffer>,
}

#[derive(Debug, Default)]
struct FramedBuffer {
    buffer: String,
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
            let _expected_len = rest.parse::<usize>().ok();
            self.framed_buffer = Some(FramedBuffer {
                buffer: String::new(),
            });
            return Ok(Vec::new());
        }

        if value == "END" && self.framed_buffer.is_none() {
            return Ok(Vec::new());
        }

        if let Some(framed) = self.framed_buffer.as_mut() {
            if value != "END" {
                framed.buffer.push_str(value);
            }

            if framed.buffer.len() > MAX_BUFFER_LENGTH {
                self.framed_buffer = None;
                return Err(anyhow!(
                    "{} framed buffer overflow while waiting for END",
                    self.label
                ));
            }

            if value != "END" {
                return Ok(Vec::new());
            }

            let framed = self.framed_buffer.take().unwrap_or_default();
            let candidate = framed.buffer;

            match serde_json::from_str(&candidate) {
                Ok(value) => return Ok(vec![value]),
                Err(error) => {
                    if let Some(recovered) = try_recover_history_record_payloads(&candidate) {
                        return Ok(recovered);
                    }

                    return Err(anyhow!(
                        "{} framed json parse failed: {error}; candidate={}",
                        self.label,
                        error_snippet(&candidate)
                    ));
                }
            }
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
                serde_json::from_str(&candidate).map_err(|error| {
                    anyhow!(
                        "{} json parse failed: {error}; candidate={}",
                        self.label,
                        error_snippet(&candidate)
                    )
                })?,
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

    #[test]
    fn waits_for_end_before_decoding_framed_messages() {
        let mut decoder = JsonObjectDecoder::new("status");
        assert!(decoder.push_str("BEGIN:11").expect("begin should parse").is_empty());
        let framed = decoder
            .push_str("{\"ok\":true}")
            .expect("payload should not decode before END");
        assert!(framed.is_empty());
        let decoded = decoder.push_str("END").expect("end should decode");
        assert_eq!(decoded[0]["ok"], true);
    }

    #[test]
    fn drops_concatenated_history_record_payloads_without_synthesizing_records() {
        let candidate = concat!(
            "{\"type\":\"history-record\",\"deviceId\":\"esp32-1\",\"record\":",
            "{\"kind\":\"node-log\",\"sequence\":1451,\"level\":\"info\",\"code\":\"runtime.app_session.online\",",
            "\"message\":\"Windows app session lease is active.\",\"timestamp\":41797785,",
            "\"bootId\":\"boot-a\",\"firmwareVersion\":\"0.5.3\",\"hardwareId\":\"esp32-1\"",
            "{\"kind\":\"motion\",\"sequence\":1585,\"state\":\"still\",\"delta\":70,\"timestamp\":50794,",
            "\"bootId\":\"boot-b\",\"firmwareVersion\":\"0.5.3\",\"hardwareId\":\"esp32-1\"}}"
        );

        let mut decoder = JsonObjectDecoder::new("status");
        assert!(decoder
            .push_str(&format!("BEGIN:{}", candidate.len()))
            .expect("begin should parse")
            .is_empty());
        assert!(decoder
            .push_str(candidate)
            .expect("decoder should buffer malformed history records")
            .is_empty());
        let values = decoder
            .push_str("END")
            .expect("decoder should drop malformed concatenated history records");

        assert!(values.is_empty());
    }

    #[test]
    fn recovers_truncated_history_record_payload() {
        let candidate = concat!(
            "{\"type\":\"history-record\",\"deviceId\":\"esp32-1\",\"record\":",
            "{\"kind\":\"motion\",\"sequence\":1604,\"state\":\"still\",\"delta\":0,",
            "\"timestamp\":2817,\"bootId\":\"esp32-085ab}"
        );

        let mut decoder = JsonObjectDecoder::new("status");
        assert!(decoder
            .push_str(&format!("BEGIN:{}", candidate.len()))
            .expect("begin should parse")
            .is_empty());
        assert!(decoder.push_str(candidate).expect("candidate should buffer").is_empty());
        let values = decoder
            .push_str("END")
            .expect("decoder should recover truncated history record");

        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["record"]["sequence"], 1604);
        assert_eq!(values[0]["record"]["state"], "still");
        assert_eq!(values[0]["record"]["bootId"], "esp32-085ab");
    }
}

fn error_snippet(candidate: &str) -> String {
    if candidate.len() <= ERROR_SNIPPET_LENGTH {
        return candidate.to_string();
    }

    format!("{}...", &candidate[..ERROR_SNIPPET_LENGTH])
}

fn try_recover_history_record_payloads(candidate: &str) -> Option<Vec<Value>> {
    if !candidate.contains("\"type\":\"history-record\"") {
        return None;
    }

    let device_id = extract_string_field(candidate, "deviceId")?;
    let record_token = "\"record\":";
    let record_start = candidate.find(record_token)? + record_token.len();
    let record_source = &candidate[record_start..];
    if split_concatenated_record_objects(record_source).len() >= 2 {
        // One broken frame can look like multiple concatenated history records.
        // Synthesizing several records from that payload creates fake duplicate
        // sequences downstream, so let the page underflow guard pause sync
        // instead of guessing.
        return Some(Vec::new());
    }

    let mut recovered = Vec::new();
    if let Some(record) = build_best_effort_history_record(record_source) {
        recovered.push(json!({
            "type": "history-record",
            "deviceId": device_id,
            "record": record,
        }));
    }

    if recovered.is_empty() {
        return None;
    }

    Some(recovered)
}

fn extract_string_field(candidate: &str, key: &str) -> Option<String> {
    let token = format!("\"{key}\":\"");
    let start = candidate.find(&token)? + token.len();
    let remainder = &candidate[start..];
    let mut escaped = false;

    for (index, ch) in remainder.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        match ch {
            '\\' => escaped = true,
            '"' => return Some(remainder[..index].replace("\\\"", "\"").replace("\\/", "/")),
            _ => {}
        }
    }

    None
}

fn split_concatenated_record_objects(source: &str) -> Vec<String> {
    let mut starts = Vec::new();
    let mut offset = 0usize;

    while let Some(index) = source[offset..].find("{\"kind\":") {
        starts.push(offset + index);
        offset += index + 1;
    }

    let mut records = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(source.len());
        let mut segment = source[*start..end].trim().to_string();
        if let Some(object_end) = find_complete_object_end(&segment) {
            segment.truncate(object_end + 1);
        } else if let Some(last_brace) = segment.rfind('}') {
            segment.truncate(last_brace + 1);
        } else {
            segment.push('}');
        }
        if !segment.ends_with('}') {
            segment.push('}');
        }
        records.push(segment);
    }

    records
}

fn build_best_effort_history_record(source: &str) -> Option<Value> {
    let kind = extract_lenient_string_field(source, "kind")?;
    let sequence = extract_u64_field(source, "sequence")?;
    let mut record = serde_json::Map::new();
    record.insert("kind".to_string(), Value::String(kind.clone()));
    record.insert("sequence".to_string(), Value::from(sequence));

    match kind.as_str() {
        "motion" => {
            if let Some(state) = extract_lenient_string_field(source, "state") {
                record.insert("state".to_string(), Value::String(state));
            }
            if let Some(delta) = extract_u64_field(source, "delta") {
                record.insert("delta".to_string(), Value::from(delta));
            }
            if let Some(timestamp) = extract_u64_field(source, "timestamp") {
                record.insert("timestamp".to_string(), Value::from(timestamp));
            }
        }
        "node-log" => {
            if let Some(level) = extract_lenient_string_field(source, "level") {
                record.insert("level".to_string(), Value::String(level));
            }
            if let Some(code) = extract_lenient_string_field(source, "code") {
                record.insert("code".to_string(), Value::String(code));
            }
            if let Some(message) = extract_lenient_string_field(source, "message") {
                record.insert("message".to_string(), Value::String(message));
            }
            if let Some(timestamp) = extract_u64_field(source, "timestamp") {
                record.insert("timestamp".to_string(), Value::from(timestamp));
            }
        }
        _ => return None,
    }

    if let Some(boot_id) = extract_lenient_string_field(source, "bootId") {
        record.insert("bootId".to_string(), Value::String(boot_id));
    }
    if let Some(firmware_version) = extract_lenient_string_field(source, "firmwareVersion") {
        record.insert("firmwareVersion".to_string(), Value::String(firmware_version));
    }
    if let Some(hardware_id) = extract_lenient_string_field(source, "hardwareId") {
        record.insert("hardwareId".to_string(), Value::String(hardware_id));
    }

    Some(Value::Object(record))
}

fn extract_lenient_string_field(candidate: &str, key: &str) -> Option<String> {
    let token = format!("\"{key}\":\"");
    let start = candidate.find(&token)? + token.len();
    let remainder = &candidate[start..];
    let mut escaped = false;

    for (index, ch) in remainder.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        match ch {
            '\\' => escaped = true,
            '"' => return Some(remainder[..index].replace("\\\"", "\"").replace("\\/", "/")),
            '}' | '{' | ',' => return Some(remainder[..index].replace("\\\"", "\"").replace("\\/", "/")),
            _ => {}
        }
    }

    if remainder.is_empty() {
        None
    } else {
        Some(remainder.replace("\\\"", "\"").replace("\\/", "/"))
    }
}

fn extract_u64_field(candidate: &str, key: &str) -> Option<u64> {
    let token = format!("\"{key}\":");
    let start = candidate.find(&token)? + token.len();
    let remainder = candidate[start..].trim_start();
    let digits: String = remainder
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}
