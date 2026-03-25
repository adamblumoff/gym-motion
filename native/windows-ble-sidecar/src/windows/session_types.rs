use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

use crate::protocol::ApprovedNodeRule;

pub(super) struct SessionHandle {
    pub(super) shutdown: watch::Sender<bool>,
    pub(super) commands: mpsc::UnboundedSender<SessionCommand>,
    pub(super) task: JoinHandle<()>,
}

pub(super) enum SessionCommand {
    StartManualScan,
    RefreshScanPolicy,
    BeginHistorySync {
        device_id: String,
        after_sequence: u64,
        max_records: usize,
        request_id: String,
    },
    AcknowledgeHistorySync {
        device_id: String,
        sequence: u64,
        request_id: String,
    },
    PairManualCandidate {
        candidate_id: String,
    },
    RecoverApprovedNode {
        rule_id: String,
    },
    ResumeApprovedNodeReconnect {
        rule_id: String,
    },
    AllowedNodesUpdated {
        nodes: Vec<ApprovedNodeRule>,
        added_rule_ids: Vec<String>,
    },
    ConnectionHealthy {
        node: crate::protocol::DiscoveredNode,
    },
    ConnectionEnded {
        node: crate::protocol::DiscoveredNode,
        reason: String,
    },
}

pub(super) fn added_allowed_rule_ids(
    previous_rules: &[ApprovedNodeRule],
    next_rules: &[ApprovedNodeRule],
) -> Vec<String> {
    next_rules
        .iter()
        .filter(|rule| !previous_rules.iter().any(|previous| previous.id == rule.id))
        .map(|rule| rule.id.clone())
        .collect()
}
