---
triggers:
  - provider: github
    event: issue_labeled
---
A GitHub issue was labeled for this factory. The issue is the tracking issue and
already exists: adopt it instead of creating another one. Run the addressing
check, then follow the standard lifecycle. Updates are mirrored to the issue.
