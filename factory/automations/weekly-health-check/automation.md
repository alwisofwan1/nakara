---
displayName: Weekly health check
enabled: false
triggers:
  - provider: schedule
    event: cron_fired
    schedule:
      cron: "0 2 * * 1" # Mondays 02:00 UTC
---
A scheduled check with no requester waiting. Have one agent run the test
suite on the default branch of each factory repository. If everything
passes, complete the task with a one-line summary and no PR. If something
fails, open one GitHub issue per repository describing the failures (do not
add the factory label) and complete the task with the issue links.
