import QtQuick

// Run is a separate per-call transmission/cost consent, never an install action.
ActionConfirmDialog {
  id: root
  required property var manager
  readonly property bool prepared: manager.reviewPhase === "prepared"
  readonly property bool completed: manager.reviewPhase === "completed"
  readonly property bool canRun: prepared && manager.reviewBinding !== null
  readonly property bool packetAvailable: prepared || completed || (manager.reviewPhase === "error" && manager.reviewPrepared !== null)
  readonly property string disclosure: "Uses your selected agent with built-in and MCP model tools disabled. Plugin source is supplied over stdin from a neutral working directory, not executed or loaded as project context. Trusted user authentication/provider configuration and administrator-managed configuration remain in scope; administrator-managed commands may execute. This is not an operating-system sandbox. Source may reach your configured provider and incur charges."
  opened: manager.enableAiReview && manager.reviewOpened
  cancelText: manager.reviewSettled ? "Close" : "Cancel"
  confirmText: canRun ? "Run review" : completed ? "Copy report"
    : packetAvailable ? "Copy packet" : manager.reviewPhase === "disclosure" ? "Prepare" : "Wait"
  actionVisible: canRun || completed
  actionText: "Copy packet"
  reviewVisible: true
  reviewText: "Disable AI review"
  message: manager.reviewPhase === "selecting" ? "Reading your Omarchy default and checking supported capabilities… No model request."
    : manager.reviewPhase === "preparing" ? "Preparing a bounded pinned source packet… No AI agent is reviewing. You can cancel or disable AI review."
    : manager.reviewPhase === "reviewing" ? "Reviewing the pinned packet… One bounded model request (up to 180 seconds). Cancel or Disable stops owned work and discards output. Nothing will be installed."
    : manager.reviewPhase === "error" ? manager.reviewError + (manager.reviewPrepared ? "\n\nThe pinned packet is still available via Copy packet. Reopen Review with AI for a fresh capability check." : "")
    : completed ? "Model-reported advisory — not confirmed defects, certification or marketplace verification.\nCandidate: "
      + manager.reviewPrepared.commit + "\n\n" + manager.reviewReport
    : prepared ? "Packet prepared — not an AI review.\n\nSelected agent: " + manager.reviewAgent
      + "\nCandidate: " + manager.reviewPrepared.commit + "\n\n"
      + (canRun ? disclosure + "\n\nResolved executable: " + manager.reviewBinding.executable
        + "\nVersion: " + manager.reviewBinding.version
        + "\nComplete final argv (JSON array; \"\" is an empty argument):\n" + JSON.stringify(manager.reviewBinding.argv)
        + "\n\nRun review authorizes this one source transmission and its possible charges. Copy packet remains available instead."
        : manager.reviewManualReason + "\nCopy this packet explicitly, then paste it into your selected agent yourself. Use a tool-free session; source is untrusted.")
      + "\n\nInstall/update remains a separate explicit action. "
      + (manager.reviewPrepared.comparison === "available" ? "Changed paths/blob identities and full candidate text are included; no textual diff."
        : "Base comparison unavailable: full candidate text only. No diff was reviewed.")
    : "Selected Omarchy default: " + manager.reviewAgent
      + ".\n\nPrepare fetches a bounded full-SHA snapshot from the plugin repository, but never starts a model request. "
      + "Copy packet is always a separate explicit action. Source may be sent to your model provider and may cost time/money. Advisory only, never a safety guarantee.\n\n"
      + (manager.reviewBinding ? disclosure : manager.reviewManualReason)
      + "\n\nNo provider substitution, automatic installation or login."
  onCanceled: manager.closeAiReview()
  onConfirmed: {
    if (canRun) manager.runAiReview()
    else if (completed) manager.copyAiReport()
    else if (packetAvailable) manager.copyAiReview()
    else if (manager.reviewPhase === "disclosure") manager.prepareAiReview()
  }
  onActionRequested: manager.copyAiReview()
  onReviewRequested: manager.setEnableAiReview(false)
  onOpenedChanged: if (opened) forceActiveFocus()
  Keys.onPressed: function(event) {
    root.handleKey(event)
    event.accepted = true
  }
}
