---
name: family-profile-bootstrap
description: "Inject per-sender family profile files into agent bootstrap context"
homepage: https://docs.openclaw.ai/automation/hooks#family-profile-bootstrap
metadata:
  {
    "openclaw":
      {
        "emoji": "👤",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Family Profile Bootstrap Hook

Loads configured per-sender profile files into `Project Context` during `agent:bootstrap`.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "family-profile-bootstrap": {
          "enabled": true,
          "workspace": "/path/to/workspace",
          "senderProfiles": {
            "12345": "person-slug"
          },
          "files": [
            "memory/people/{profile}.md",
            "memory/people-policies/{profile}.md",
            "memory/people-summaries/{profile}-latest.md"
          ]
        }
      }
    }
  }
}
```

`senderProfiles` maps trusted provider sender ids to local profile slugs. File paths are
workspace-relative, and all reads must stay inside the workspace root.
