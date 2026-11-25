---
displayName: Slack request
# Off until you list your team: the Slack member IDs (profile → ⋯ → Copy
# member ID) that may send requests and answer in a work item's thread.
# Everyone else is ignored and logged.
enabled: true
triggers:
  - provider: slack
    event: message
    filter:
      members: [U0945MMDT5X]
---
A listed Slack member sent this request by mentioning the bot or in a direct
message. Updates and questions reach them in the request's thread; they answer
by replying there. Run the addressing check, then follow the standard
lifecycle. When the work needs a tracking issue, create one in the matching
factory repository.
